# Audio Lab serial protocol v1

Transport: USB CDC / Web Serial at **921,600 baud**, 8-N-1. Control and telemetry use one UTF-8 JSON object per line. Unknown message types and unknown fields must be ignored for forward compatibility.

## Session

Browser → board:

```json
{"type":"hello","protocol":1}
```

Board → browser:

```json
{"type":"hello.ack","protocol":1,"board":"waveshare-esp32-s3-audio","firmware":"0.3.0","capabilities":["serial.heartbeat","led.ring","mic.stereo","speaker.pcm","display.eyes"]}
```

Once connected, the browser sends a heartbeat every second:

```json
{"type":"ping","seq":42}
```

The board responds immediately:

```json
{"type":"pong","seq":42,"uptimeMs":91824}
```

The dashboard closes the session if no pong arrives for 3.5 seconds. The firmware also pauses microphone telemetry after 3.5 seconds without a ping, preventing a disconnected or stalled browser from creating serial backpressure. Ping/pong traffic is paused while raw speaker bytes are in flight.

## LED control

```json
{"type":"led.set","mode":"rainbow","color":"#7c5cff","brightness":72,"speed":1.2,"easing":"sine","led":null}
```

- `mode`: `solid`, `rainbow`, `breathe`, `chase`, or `flicker`.
- `brightness`: 0–100 percent, applied after pattern generation.
- `speed`: 0.1–4.0 multiplier.
- `easing`: `sine`, `linear`, `quadIn`, `quadOut`, or `smoothstep`.
- `led`: `null` for the whole ring or a zero-based pixel index.

The firmware owns animation timing. The dashboard sends state changes only, preventing serial jitter from appearing in continuous effects.

## Eye display control

The 172 × 320 ST7789V3 LCD is used in landscape orientation. The browser sends state changes only; the ESP32 renders and eases every frame locally.

```json
{"type":"display.set","enabled":true,"animation":"curious","requestId":42}
```

`animation` is `idle`, `happy`, `curious`, `excited`, `sleepy`, `thinking`, or `surprised`. Repeating the active state is idempotent and does not restart the animation. The board acknowledges every request:

```json
{"type":"display.ack","enabled":true,"animation":"curious","requestId":42}
```

After `hello.ack`, the board reports its current state so a reconnected dashboard matches the hardware:

```json
{"type":"display.state","enabled":true,"animation":"idle","ready":true}
```

`surprised` is a one-shot animation. After its reaction and recovery blink, firmware returns to idle and emits `display.animation.complete`.

## Microphone configuration and telemetry

```json
{"type":"mic.config","gainDb":24,"sensitivity":1.4,"noiseGateDb":-58,"stream":true}
```

`gainDb` configures the ES7210 input gain. `sensitivity` is a dashboard display multiplier and may be echoed without changing the codec. `noiseGateDb` is applied before level calculation.

At 20–25 frames per second, board → browser:

```json
{"type":"mic.frame","seq":1842,"left":0.126,"right":0.109,"peakL":0.188,"peakR":0.153,"samples":[-3,8,14,5,-9]}
```

- Levels and peaks are linear full-scale values in `[0,1]`; Audio Lab converts them to dBFS.
- `samples` contains 64–128 signed, down-sampled waveform values normalized nominally to `[-100,100]`.
- The two physical mic channels remain independent. Do not mix to mono before calculating telemetry.
- Telemetry is for measurement visibility, not full-band audio streaming. This keeps USB and browser rendering headroom available.

## Speaker transfer

Browser first sends:

```json
{"type":"speaker.begin","format":"pcm_s16le","sampleRate":16000,"channels":1,"bytes":64000,"volume":55}
```

The next exactly `bytes` bytes are raw signed little-endian PCM with no line framing. The board must consume the declared length, queue chunks to I2S, and then resume JSON parsing. The browser then sends:

```json
{"type":"speaker.end"}
```

Board responses:

```json
{"type":"speaker.ready","bufferBytes":65536}
{"type":"speaker.done","playedBytes":64000,"underruns":0}
```

The browser waits for `speaker.ready`, then sends 1,024-byte writes paced close to the 32 kB/s PCM consumption rate. No JSON control or heartbeat messages may be inserted between `speaker.begin` and the declared raw byte count.

## Errors

```json
{"type":"error","code":"invalid_audio_format","message":"Expected mono PCM at 16000 Hz"}
```

Errors do not end the session. A malformed JSON line is discarded at the next newline.

## Extension pattern

New hardware follows `<module>.<verb>` names and reports its schema in `hello.ack`. Examples:

```json
{"type":"mpr121.config","touchThreshold":12,"releaseThreshold":6,"debounceMs":25}
{"type":"mpr121.frame","touched":5,"electrodes":[0,0,1,0,0,0,0,0,0,0,0,0]}
{"type":"fsr.config","sampleRate":100,"smoothing":0.15,"trigger":0.35}
{"type":"fsr.frame","raw":2310,"normalized":0.57}
```
