// Dashboard's live MQTT feed: one connection, all topics -> fleet store.
import { useEffect, useState } from "react";
import { connectIot, type ConnState, type IotConnection } from "../shared/awsIot";
import { TOPICS, type Alert, type DeviceEvent, type PresenceEvent, type Telemetry } from "../shared/types";
import { fleet } from "./store";

let connection: IotConnection | null = null;

export function useLiveFeed() {
  const [state, setState] = useState<ConnState>("connecting");
  useEffect(() => {
    let cancelled = false;
    connectIot({
      clientId: `dash-${Math.random().toString(36).slice(2, 10)}`,
      onState: (s) => {
        setState(s);
        if (s === "online") fleet.info("Dashboard connected to AWS IoT Core", "ok", "☁️");
      },
    })
      .then((c) => {
        if (cancelled) return c.close();
        connection = c;
        c.client.subscribe([TOPICS.allTelemetry, TOPICS.allEvents, TOPICS.alerts, TOPICS.presence], { qos: 0 });
        c.client.on("message", (topic, payload) => {
          let msg: any;
          try {
            msg = JSON.parse(payload.toString());
          } catch {
            return;
          }
          if (topic.endsWith("/telemetry")) fleet.telemetry(msg as Telemetry);
          else if (topic.endsWith("/events")) fleet.event(msg as DeviceEvent);
          else if (topic === TOPICS.alerts) fleet.alert(msg as Alert);
          else if (topic.startsWith("$aws/events/presence/")) fleet.presence(msg as PresenceEvent);
        });
      })
      .catch((e) => {
        setState("offline");
        fleet.info(`Could not connect: ${e.message}`, "fail", "⛔");
      });
    return () => {
      cancelled = true;
      connection?.close();
      connection = null;
    };
  }, []);
  return state;
}

export function publish(topic: string, body: object) {
  connection?.client.publish(topic, JSON.stringify(body), { qos: 1 });
}

/** Ask a phone to change something via its AWS IoT Device Shadow (desired state). */
export function setDesired(deviceId: string, desired: Record<string, unknown>) {
  publish(`$aws/things/${deviceId}/shadow/update`, { state: { desired } });
  fleet.info(`Shadow desired → ${deviceId}: ${JSON.stringify(desired)}`, "info", "🪞");
}
