# Audio Lab

Browser-based hardware test console for the [Waveshare ESP32-S3-AUDIO-Board](https://docs.waveshare.com/ESP32-S3-AUDIO-Board). It uses Web Serial for low-latency local control and measurement without a network or pairing step.

## What is included

- Seven-pixel RGB ring control: solid, rainbow, breathing, orbit/chase, and flicker modes; colour, brightness, rate, easing, and single-pixel selection.
- ST7789V3 eye display: on/off control and seven ESP32-rendered expressive animation states with eased transitions.
- Dual-microphone lab: live waveform, independent levels and peaks, channel-balance direction cue, codec gain, visual sensitivity, noise gate, physical-condition tags, CSV export.
- Speaker verifier: validates 16 kHz, signed 16-bit, mono PCM WAV files (or explicitly named raw `.pcm` / `.raw`), then transfers them to the board.
- A simulated mic signal when no board is connected, so the interface can be evaluated immediately.
- A versioned, line-oriented protocol designed for future MPR121, FSR, and other device modules.

## Run locally

```bash
pnpm install
pnpm dev
```

Open the printed local URL in Chrome or Edge. Web Serial requires a secure context (`https` or `localhost`) and a user click on **Connect board**.

## Connect hardware

1. Flash firmware that implements [the serial protocol](docs/SERIAL_PROTOCOL.md).
2. Connect the board over its USB Type-C port.
3. Open Audio Lab and click **Connect board**.
4. Select the ESP32-S3 serial port. The dashboard opens it at 921,600 baud.

The UI remains usable in demo mode when hardware is not connected. See [firmware/README.md](firmware/README.md) for verified board mappings and the firmware integration contract.

## Validation

```bash
pnpm build
node --test tests/rendered-html.test.mjs
```

## Architecture

The transport accepts newline-delimited JSON control and telemetry messages. PCM playback switches temporarily to a length-delimited binary payload, then returns to JSON framing. UI modules do not access Web Serial directly; they publish protocol messages, which keeps a future Web Bluetooth transport or new sensor module isolated from the controls and visualizations.
