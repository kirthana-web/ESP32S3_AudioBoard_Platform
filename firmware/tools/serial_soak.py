#!/usr/bin/env python3
"""Exercise heartbeat, LED control, and mic telemetry over one serial session."""

import argparse
import json
import time

import serial
from serial.tools import list_ports


def find_board() -> str:
    matches = [
        port.device
        for port in list_ports.comports()
        if port.vid == 0x303A and port.pid == 0x1001
    ]
    if not matches:
        raise RuntimeError("ESP32-S3 USB serial/JTAG port not found")
    return next((port for port in matches if "/cu." in port), matches[0])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=20)
    args = parser.parse_args()

    port_name = find_board()
    port = serial.Serial()
    port.port = port_name
    port.baudrate = 921600
    port.timeout = 0.05
    port.dtr = False
    port.rts = False
    port.open()

    received = bytearray()
    hello = False
    sent_pings = 0
    pong_sequences: set[int] = set()
    mic_frames = 0
    errors: list[dict] = []
    started = time.monotonic()
    next_ping = started
    next_led = started
    led_phase = 0

    def send(message: dict) -> None:
        port.write((json.dumps(message, separators=(",", ":")) + "\n").encode())

    time.sleep(0.5)
    port.reset_input_buffer()
    send({"type": "hello", "protocol": 1})

    try:
        while time.monotonic() - started < args.seconds:
            now = time.monotonic()
            if now >= next_ping:
                sent_pings += 1
                send({"type": "ping", "seq": sent_pings})
                next_ping += 1
            if now >= next_led:
                led_phase += 1
                send({
                    "type": "led.set",
                    "mode": "rainbow" if led_phase % 2 else "breathe",
                    "color": "#00d4a6",
                    "brightness": 20,
                    "speed": 1.2,
                    "easing": "sine",
                    "led": None,
                })
                next_led += 3

            received.extend(port.read(8192))
            while b"\n" in received:
                raw, _, remainder = received.partition(b"\n")
                received = bytearray(remainder)
                try:
                    message = json.loads(raw)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                message_type = message.get("type")
                if message_type == "hello.ack":
                    hello = True
                elif message_type == "pong":
                    pong_sequences.add(int(message.get("seq", -1)))
                elif message_type == "mic.frame":
                    mic_frames += 1
                elif message_type == "error":
                    errors.append(message)
    finally:
        port.close()

    missing = sorted(set(range(1, sent_pings + 1)) - pong_sequences)
    print(json.dumps({
        "port": port_name,
        "seconds": args.seconds,
        "hello": hello,
        "pings": sent_pings,
        "pongs": len(pong_sequences),
        "missingPongs": missing,
        "micFrames": mic_frames,
        "errors": errors,
    }, indent=2))

    if not hello or missing or not mic_frames or errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
