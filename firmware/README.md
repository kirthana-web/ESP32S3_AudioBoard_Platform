# Firmware adapter

This directory now contains a flashable PlatformIO/Arduino implementation of `docs/SERIAL_PROTOCOL.md` for the Waveshare board. It drives the LED ring and 1.47-inch eye display, streams dual-channel mic telemetry, applies ES7210 gain, and accepts signed 16-bit mono PCM for speaker playback.

## Build and upload

```bash
cd firmware
pio run
pio run --target upload
```

The default serial rate is 921,600 baud. PlatformIO auto-detects the port because macOS can change names such as `usbmodem2101` to `usbmodem101` after a reset. The checked-in ES7210 and ES8311 drivers are the Apache-2.0-licensed versions distributed in Waveshare's official Arduino demo package.

Run a heartbeat/LED/microphone soak test after flashing:

```bash
python tools/serial_soak.py --seconds 20
```

## Verified Waveshare mappings

These values come from the current official Waveshare demo package and its `bsp_board.h` / Arduino audio configuration:

| Function | Device / GPIO |
| --- | --- |
| RGB ring | 7 × WS2812, data on GPIO 38 |
| Audio I²C | SDA GPIO 11, SCL GPIO 10, bus 0 |
| I²S MCLK | GPIO 12 |
| I²S BCLK / SCLK | GPIO 13 |
| I²S LRCK / WS | GPIO 14 |
| Microphone data in | GPIO 15 |
| Speaker data out | GPIO 16 |
| Microphone codec | ES7210, default address 0x40 |
| Speaker codec | ES8311 |
| Amplifier enable | TCA9555 expander output 8 |
| LCD controller / size | ST7789V3, 172 × 320 (landscape 320 × 172) |
| LCD DIN / CLK / CS | GPIO 6 / GPIO 4 / GPIO 3 |
| LCD DC / backlight | GPIO 7 / GPIO 5 |
| LCD reset | TCA9555 extended output 0 |

The LCD mapping above matches the photographed Dupont wiring to the board's QSPI-LCD breakout. `DIN` intentionally uses GPIO 6 (the breakout's `LCD_SDA3`) rather than the separate FPC connector's SPI-MOSI mapping. Power is connected to 5 V and GND as shown; the Waveshare module accepts 3.3 V or 5 V supply.

The shared I²S bus is configured at 16 kHz. Waveshare's current ESP-IDF demo opens the ES7210 as two-channel, 32-bit codec data and converts speaker PCM as needed; preserve that bus configuration even though the browser accepts 16-bit mono speaker files.

## Recommended task split

- **serial task**: line parser plus exact-length binary receive state for speaker data.
- **LED task**: 50–100 Hz pattern generation using `espressif/led_strip`; store state from `led.set` in a queue.
- **audio capture task**: read ES7210 frames continuously, calculate per-channel RMS/peaks, down-sample a waveform window, emit `mic.frame` at 20–25 Hz.
- **speaker task**: consume PCM from a ring buffer and write it through `esp_codec_dev`; enable the amplifier through TCA9555 only during playback.

Use `espressif/esp_codec_dev`, `espressif/led_strip`, and `espressif/esp_io_expander_tca95xx_16bit`, matching the official Waveshare ESP-IDF example. Keep serial parsing off the audio task so a slow browser cannot interrupt I²S DMA.

## Measurement caveat

The dashboard's direction cue uses only the relative RMS level of the two microphones. It is useful for visualizing direction and coverings during bench tests, but it is not a calibrated direction-of-arrival estimator. Preserve raw left/right levels in telemetry so a later GCC-PHAT or beamforming module can replace it without changing the UI contract.
