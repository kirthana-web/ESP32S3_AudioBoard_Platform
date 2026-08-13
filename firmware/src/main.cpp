#include <Arduino.h>
#include <Wire.h>
#include <ESP_I2S.h>
#include <Adafruit_NeoPixel.h>
#include "es7210.h"
#include "es8311.h"

namespace board {
constexpr int I2C_SDA = 11;
constexpr int I2C_SCL = 10;
constexpr int I2S_MCLK = 12;
constexpr int I2S_BCLK = 13;
constexpr int I2S_LRCK = 14;
constexpr int I2S_DIN = 15;
constexpr int I2S_DOUT = 16;
constexpr int LED_DATA = 38;
constexpr int LED_COUNT = 7;
constexpr uint8_t TCA9555 = 0x20;
}

enum class LedMode { Solid, Rainbow, Breathe, Chase, Flicker };
enum class Ease { Sine, Linear, QuadIn, QuadOut, Smoothstep };

struct LedState {
  LedMode mode = LedMode::Rainbow;
  Ease ease = Ease::Sine;
  uint8_t r = 124, g = 92, b = 255;
  uint8_t brightness = 72;
  float speed = 1.2f;
  int selected = -1;
} leds;

I2SClass audioBus;
// Waveshare's factory firmware declares this board's WS2812 component order as RGB.
Adafruit_NeoPixel pixels(board::LED_COUNT, board::LED_DATA, NEO_RGB + NEO_KHZ800);
es7210_dev_handle_t micCodec = nullptr;
es8311_handle_t speakerCodec = nullptr;

String commandLine;
bool micStream = true;
volatile bool audioReady = false;
volatile bool audioInitDone = false;
float visualSensitivity = 1.4f;
int micGainDb = 24;
int noiseGateDb = -58;
uint32_t micSequence = 0;
uint32_t pcmRemaining = 0;
uint32_t pcmPlayed = 0;
uint8_t speakerVolume = 55;
uint32_t lastLedFrame = 0;
uint32_t lastHostPing = 0;
bool heartbeatActive = false;

static void sendError(const char *code, const char *message);

static float clamp01(float value) { return value < 0 ? 0 : value > 1 ? 1 : value; }

static float applyEase(float value) {
  value = clamp01(value);
  switch (leds.ease) {
    case Ease::Linear: return value;
    case Ease::QuadIn: return value * value;
    case Ease::QuadOut: return 1.0f - (1.0f - value) * (1.0f - value);
    case Ease::Smoothstep: return value * value * (3.0f - 2.0f * value);
    default: return 0.5f - 0.5f * cosf(value * PI);
  }
}

static uint32_t wheel(uint8_t position) {
  position = 255 - position;
  if (position < 85) return pixels.Color(255 - position * 3, 0, position * 3);
  if (position < 170) { position -= 85; return pixels.Color(0, position * 3, 255 - position * 3); }
  position -= 170;
  return pixels.Color(position * 3, 255 - position * 3, 0);
}

static uint32_t scaleColor(uint32_t color, float amount) {
  amount *= leds.brightness / 100.0f;
  return pixels.Color(((color >> 16) & 0xff) * amount, ((color >> 8) & 0xff) * amount, (color & 0xff) * amount);
}

static void renderLeds() {
  const uint32_t now = millis();
  if (now - lastLedFrame < 20) return;
  lastLedFrame = now;
  const float phase = fmodf(now / 1000.0f * leds.speed, 1.0f);
  const uint32_t base = pixels.Color(leds.r, leds.g, leds.b);
  for (int i = 0; i < board::LED_COUNT; ++i) {
    uint32_t color = base;
    float level = 1.0f;
    if (leds.mode == LedMode::Rainbow) color = wheel((uint8_t)(phase * 255 + i * 255 / board::LED_COUNT));
    if (leds.mode == LedMode::Breathe) level = 0.08f + 0.92f * applyEase(0.5f - 0.5f * cosf(phase * TWO_PI));
    if (leds.mode == LedMode::Chase) {
      float pixelPhase = fmodf(phase + i / (float)board::LED_COUNT, 1.0f);
      level = 0.04f + 0.96f * powf(1.0f - pixelPhase, 3.0f);
    }
    if (leds.mode == LedMode::Flicker) {
      uint32_t hash = (now / max(1, (int)(90 / leds.speed))) * 1103515245u + i * 2654435761u;
      level = 0.18f + 0.82f * ((hash >> 24) / 255.0f);
    }
    if (leds.selected >= 0 && leds.selected != i) level = 0;
    pixels.setPixelColor(i, scaleColor(color, level));
  }
  pixels.show();
}

static bool i2cWrite(uint8_t device, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(device); Wire.write(reg); Wire.write(value);
  return Wire.endTransmission() == 0;
}

static uint8_t i2cRead(uint8_t device, uint8_t reg) {
  Wire.beginTransmission(device); Wire.write(reg); Wire.endTransmission(false);
  Wire.requestFrom(device, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0xff;
}

static void enableAmplifier(bool enabled) {
  uint8_t config = i2cRead(board::TCA9555, 0x07); // Port 1 config; EXIO8 is bit 0.
  uint8_t output = i2cRead(board::TCA9555, 0x03); // Port 1 output.
  i2cWrite(board::TCA9555, 0x07, config & ~0x01);
  i2cWrite(board::TCA9555, 0x03, enabled ? output | 0x01 : output & ~0x01);
}

static es7210_mic_gain_t gainSetting(int db) {
  if (db <= 0) return ES7210_MIC_GAIN_0DB;
  if (db >= 37) return ES7210_MIC_GAIN_37_5DB;
  return static_cast<es7210_mic_gain_t>(constrain((db + 1) / 3, 0, 12));
}

static bool configureMic() {
  es7210_codec_config_t config = {
    .sample_rate_hz = 16000,
    .mclk_ratio = 256,
    .i2s_format = ES7210_I2S_FMT_I2S,
    .bit_width = ES7210_I2S_BITS_32B,
    .mic_bias = ES7210_MIC_BIAS_2V87,
    .mic_gain = gainSetting(micGainDb),
  };
  config.flags.tdm_enable = true;
  return es7210_config_codec(micCodec, &config) == ESP_OK && es7210_config_volume(micCodec, 0) == ESP_OK;
}

static bool configureAudio() {
  Serial.println("{\"type\":\"debug\",\"stage\":\"i2c.begin\"}");
  Wire.begin(board::I2C_SDA, board::I2C_SCL, 400000);
  Serial.println("{\"type\":\"debug\",\"stage\":\"i2s.begin\"}");
  audioBus.setPins(board::I2S_BCLK, board::I2S_LRCK, board::I2S_DOUT, board::I2S_DIN, board::I2S_MCLK);
  audioBus.setTimeout(30);
  if (!audioBus.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO)) return false;

  Serial.println("{\"type\":\"debug\",\"stage\":\"mic.begin\"}");
  es7210_i2c_config_t micI2c = { .i2c_port = I2C_NUM_0, .i2c_addr = ES7210_ADDRRES_00 };
  if (es7210_new_codec(&micI2c, &micCodec) != ESP_OK || !configureMic()) return false;

  Serial.println("{\"type\":\"debug\",\"stage\":\"speaker.begin\"}");
  speakerCodec = es8311_create(I2C_NUM_0, ES8311_ADDRRES_0);
  const es8311_clock_config_t clock = {
    .mclk_inverted = false, .sclk_inverted = false, .mclk_from_mclk_pin = true,
    .mclk_frequency = 16000 * 256, .sample_frequency = 16000,
  };
  if (!speakerCodec || es8311_init(speakerCodec, &clock, ES8311_RESOLUTION_32, ES8311_RESOLUTION_32) != ESP_OK) return false;
  es8311_voice_volume_set(speakerCodec, speakerVolume, nullptr);
  es8311_microphone_config(speakerCodec, false);
  enableAmplifier(false);
  return true;
}

static void audioInitTask(void *) {
  audioReady = configureAudio();
  audioInitDone = true;
  if (audioReady) Serial.println("{\"type\":\"audio.ready\"}");
  else sendError("audio_init_failed", "Codec or I2S initialization failed");
  vTaskDelete(nullptr);
}

static String jsonString(const String &line, const char *key, const String &fallback = "") {
  String marker = String("\"") + key + "\":\"";
  int begin = line.indexOf(marker); if (begin < 0) return fallback;
  begin += marker.length(); int end = line.indexOf('"', begin);
  return end < 0 ? fallback : line.substring(begin, end);
}

static float jsonNumber(const String &line, const char *key, float fallback) {
  String marker = String("\"") + key + "\":";
  int begin = line.indexOf(marker); if (begin < 0) return fallback;
  begin += marker.length(); return line.substring(begin).toFloat();
}

static bool jsonBool(const String &line, const char *key, bool fallback) {
  String marker = String("\"") + key + "\":";
  int begin = line.indexOf(marker); if (begin < 0) return fallback;
  begin += marker.length(); return line.substring(begin).startsWith("true");
}

static void parseHexColor(const String &hex) {
  if (hex.length() != 7 || hex[0] != '#') return;
  uint32_t value = strtoul(hex.c_str() + 1, nullptr, 16);
  leds.r = value >> 16; leds.g = value >> 8; leds.b = value;
}

static void sendError(const char *code, const char *message) {
  Serial.printf("{\"type\":\"error\",\"code\":\"%s\",\"message\":\"%s\"}\n", code, message);
}

static void handleCommand(const String &line) {
  const String type = jsonString(line, "type");
  if (type == "hello") {
    lastHostPing = millis();
    heartbeatActive = true;
    Serial.println("{\"type\":\"hello.ack\",\"protocol\":1,\"board\":\"waveshare-esp32-s3-audio\",\"firmware\":\"0.2.0\",\"capabilities\":[\"serial.heartbeat\",\"led.ring\",\"mic.stereo\",\"speaker.pcm\"]}");
    return;
  }
  if (type == "ping") {
    lastHostPing = millis();
    heartbeatActive = true;
    Serial.printf("{\"type\":\"pong\",\"seq\":%lu,\"uptimeMs\":%lu}\n",
                  (unsigned long)jsonNumber(line, "seq", 0), (unsigned long)millis());
    return;
  }
  if (type == "led.set") {
    String mode = jsonString(line, "mode", "solid");
    leds.mode = mode == "rainbow" ? LedMode::Rainbow : mode == "breathe" ? LedMode::Breathe : mode == "chase" ? LedMode::Chase : mode == "flicker" ? LedMode::Flicker : LedMode::Solid;
    String ease = jsonString(line, "easing", "sine");
    leds.ease = ease == "linear" ? Ease::Linear : ease == "quadIn" ? Ease::QuadIn : ease == "quadOut" ? Ease::QuadOut : ease == "smoothstep" ? Ease::Smoothstep : Ease::Sine;
    parseHexColor(jsonString(line, "color", "#7c5cff"));
    leds.brightness = constrain((int)jsonNumber(line, "brightness", leds.brightness), 0, 100);
    leds.speed = constrain(jsonNumber(line, "speed", leds.speed), 0.1f, 4.0f);
    int marker = line.indexOf("\"led\":");
    leds.selected = marker >= 0 && !line.substring(marker + 6).startsWith("null") ? constrain((int)jsonNumber(line, "led", -1), -1, 6) : -1;
    return;
  }
  if (type == "mic.config") {
    micStream = jsonBool(line, "stream", micStream);
    visualSensitivity = constrain(jsonNumber(line, "sensitivity", visualSensitivity), 0.5f, 4.0f);
    noiseGateDb = constrain((int)jsonNumber(line, "noiseGateDb", noiseGateDb), -72, -18);
    int requestedGain = constrain((int)jsonNumber(line, "gainDb", micGainDb), 0, 37);
    if (requestedGain != micGainDb) { micGainDb = requestedGain; if (audioReady) configureMic(); }
    return;
  }
  if (type == "speaker.begin") {
    if (!audioReady) { sendError("audio_not_ready", "Audio codec initialization is not complete"); return; }
    if ((int)jsonNumber(line, "sampleRate", 0) != 16000 || (int)jsonNumber(line, "channels", 0) != 1 || jsonString(line, "format") != "pcm_s16le") {
      sendError("invalid_audio_format", "Expected mono pcm_s16le at 16000 Hz"); return;
    }
    pcmRemaining = (uint32_t)jsonNumber(line, "bytes", 0);
    pcmPlayed = 0;
    speakerVolume = constrain((int)jsonNumber(line, "volume", 55), 0, 100);
    es8311_voice_volume_set(speakerCodec, speakerVolume, nullptr);
    enableAmplifier(true);
    Serial.println("{\"type\":\"speaker.ready\",\"bufferBytes\":65536}");
    return;
  }
  if (type == "speaker.end") {
    enableAmplifier(false);
    Serial.printf("{\"type\":\"speaker.done\",\"playedBytes\":%lu,\"underruns\":0}\n", (unsigned long)pcmPlayed);
  }
}

static void receiveSpeakerPcm() {
  static uint8_t monoBytes[1024];
  static int32_t stereo[1024];
  int available = Serial.available(); if (available <= 0) return;
  size_t wanted = min((uint32_t)sizeof(monoBytes), pcmRemaining);
  size_t got = Serial.readBytes(monoBytes, min((size_t)available, wanted));
  got &= ~1u;
  const int16_t *mono = reinterpret_cast<int16_t *>(monoBytes);
  for (size_t i = 0; i < got / 2; ++i) stereo[i * 2] = stereo[i * 2 + 1] = (int32_t)mono[i] << 16;
  size_t written = 0;
  esp_err_t result = i2s_channel_write(audioBus.txChan(), stereo, got * 4, &written, pdMS_TO_TICKS(60));
  if (result != ESP_OK || written != got * 4) {
    pcmRemaining = 0;
    enableAmplifier(false);
    sendError("speaker_i2s_timeout", "Speaker output timed out; playback was stopped");
    return;
  }
  pcmRemaining -= got; pcmPlayed += got;
}

static void streamMicFrame() {
  static uint32_t lastFrame = 0;
  if (!audioReady || !micStream || pcmRemaining || millis() - lastFrame < 50) return;
  if (heartbeatActive && millis() - lastHostPing > 3500) return;
  lastFrame = millis();
  int32_t samples[256];
  size_t received = audioBus.readBytes(reinterpret_cast<char *>(samples), sizeof(samples));
  if (received < 16) return;
  size_t pairs = received / (sizeof(int32_t) * 2);
  double sumL = 0, sumR = 0; int64_t peakL = 0, peakR = 0;
  for (size_t i = 0; i < pairs; ++i) {
    int64_t l = samples[i * 2], r = samples[i * 2 + 1];
    sumL += (double)l * l; sumR += (double)r * r;
    peakL = max(peakL, abs(l)); peakR = max(peakR, abs(r));
  }
  float rmsL = sqrt(sumL / pairs) / 2147483648.0f, rmsR = sqrt(sumR / pairs) / 2147483648.0f;
  const float gate = powf(10.0f, noiseGateDb / 20.0f);
  if (rmsL < gate) rmsL = 0; if (rmsR < gate) rmsR = 0;
  char header[224];
  snprintf(header, sizeof(header), "{\"type\":\"mic.frame\",\"seq\":%lu,\"left\":%.5f,\"right\":%.5f,\"peakL\":%.5f,\"peakR\":%.5f,\"samples\":[", (unsigned long)micSequence++, rmsL, rmsR, peakL / 2147483648.0f, peakR / 2147483648.0f);
  String frameLine(header);
  frameLine.reserve(640);
  const size_t count = min((size_t)64, pairs);
  for (size_t i = 0; i < count; ++i) {
    size_t source = i * pairs / count;
    int value = constrain((int)(samples[source * 2] / 21474836.48f * visualSensitivity), -100, 100);
    if (i) frameLine += ',';
    frameLine += value;
  }
  frameLine += "]}";
  Serial.println(frameLine);
}

void setup() {
  Serial.begin(921600);
  Serial.setRxBufferSize(65536);
  Serial.setTxBufferSize(8192);
  Serial.setTxTimeoutMs(5);
  delay(300);
  Serial.println("{\"type\":\"debug\",\"stage\":\"setup\"}");
  pixels.begin(); pixels.clear(); pixels.show();
  Serial.println("{\"type\":\"boot\",\"board\":\"waveshare-esp32-s3-audio\",\"firmware\":\"0.2.0\"}");
  xTaskCreatePinnedToCore(audioInitTask, "audio-init", 8192, nullptr, 1, nullptr, 0);
}

void loop() {
  renderLeds();
  if (pcmRemaining) receiveSpeakerPcm();
  else {
    while (Serial.available()) {
      char c = Serial.read();
      if (c == '\n') { if (commandLine.length()) handleCommand(commandLine); commandLine = ""; }
      else if (c != '\r' && commandLine.length() < 1024) commandLine += c;
    }
    streamMicFrame();
  }
  delay(1);
}
