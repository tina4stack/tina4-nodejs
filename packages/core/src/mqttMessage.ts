/**
 * One MQTT 3.1.1 application message as delivered by the broker.
 *
 * Shaped like the Queue's job (its unit of work): it carries the payload plus
 * the delivery metadata a consumer needs, and it knows how to acknowledge itself
 * back to the client it came from. Mirrors tina4_python.mqtt.MqttMessage,
 * Tina4::MqttMessage (Ruby), and Tina4\MqttMessage (PHP).
 *
 * The two flags matter for correctness, not decoration:
 *
 *   retained  — the broker replayed the topic's last known value to us because
 *               we subscribed AFTER it was published. It is current state, not a
 *               fresh event.
 *   duplicate — the DUP flag. The broker is REDELIVERING a QoS 1 message it never
 *               saw acknowledged. QoS 1 is at-least-once, so a duplicate is
 *               guaranteed eventually; a consumer that treats a DUP delivery as a
 *               new sample double-counts energy or mileage. Key the ingest on
 *               (deviceId, deviceTimestamp) and it is harmless.
 *
 * The payload is a Buffer of the raw bytes; text() decodes it for JSON/string
 * payloads.
 */

/** The slice of an Mqtt client an MqttMessage needs to acknowledge itself. */
export interface MqttAcknowledger {
  acknowledge(packetId: number): Promise<boolean>;
}

export class MqttMessage {
  private acknowledgedFlag = false;

  constructor(
    public readonly topic: string,
    public readonly payload: Buffer,
    public readonly qos: number = 0,
    public readonly retained: boolean = false,
    public readonly duplicate: boolean = false,
    public readonly packetId: number | null = null,
    private readonly client: MqttAcknowledger | null = null,
  ) {}

  /** True when the broker replayed this as the topic's retained (last known) value. */
  isRetained(): boolean {
    return this.retained;
  }

  /**
   * True when the broker set the DUP flag — a REDELIVERY of a QoS 1 message we
   * never acknowledged, not a new sample.
   */
  isDuplicate(): boolean {
    return this.duplicate;
  }

  /**
   * PUBACK a QoS 1 delivery so the broker stops redelivering it.
   *
   * A QoS 0 message needs no acknowledgement, and a second call is a no-op, so
   * this is always safe to call once processing succeeded. Returns true only
   * when a PUBACK was actually sent.
   */
  async acknowledge(): Promise<boolean> {
    if (this.acknowledgedFlag || this.qos === 0 || this.packetId === null || this.client === null) {
      return false;
    }
    await this.client.acknowledge(this.packetId);
    this.acknowledgedFlag = true;
    return true;
  }

  /** True once this message has been acknowledged back to the broker. */
  isAcknowledged(): boolean {
    return this.acknowledgedFlag;
  }

  /** The payload decoded as text (for JSON / string payloads). */
  text(encoding: BufferEncoding = "utf-8"): string {
    return this.payload.toString(encoding);
  }

  /** The message as a plain object. */
  toObject(): {
    topic: string;
    payload: Buffer;
    qos: number;
    retained: boolean;
    duplicate: boolean;
    packetId: number | null;
  } {
    return {
      topic: this.topic,
      payload: this.payload,
      qos: this.qos,
      retained: this.retained,
      duplicate: this.duplicate,
      packetId: this.packetId,
    };
  }

  /** String form is the payload text (parity with Python __str__ / Ruby to_s). */
  toString(): string {
    return this.text();
  }
}
