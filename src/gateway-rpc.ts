import * as crypto from "crypto";
import { resolveGatewayPort } from "./constants";

const TAG = "[gateway-rpc]";

// 同步解码 WebSocket 消息数据（binaryType=arraybuffer，不会出现 Blob）
function decodeMessageData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return data.toString("utf-8");
  return String(data);
}

type RpcResult = { ok: boolean; payload?: any; error?: { code: string; message: string } };

function connectGateway(
  token: string,
  timeoutMs: number,
  onConnected: (ctx: { ws: WebSocket; done: (result: RpcResult) => void }) => void,
): Promise<RpcResult> {
  return new Promise((resolve) => {
    let settled = false;
    const url = `ws://127.0.0.1:${resolveGatewayPort()}/`;
    const connectId = crypto.randomUUID();

    const done = (result: RpcResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(result);
    };

    const timer = setTimeout(
      () => done({ ok: false, error: { code: "timeout", message: "RPC timeout" } }),
      timeoutMs,
    );

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {};

    ws.onmessage = (event: MessageEvent) => {
      let raw: string;
      try {
        raw = decodeMessageData(event.data);
      } catch {
        return;
      }

      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === "event" && msg.event === "connect.challenge") {
        ws.send(JSON.stringify({
          type: "req",
          id: connectId,
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: "gateway-client", displayName: "OneClaw", version: "1.0", platform: process.platform, mode: "backend" },
            auth: { token },
            role: "operator",
            scopes: ["operator.read", "operator.admin"],
          },
        }));
        return;
      }

      if (msg.type === "res" && msg.id === connectId) {
        if (!msg.ok) {
          done({ ok: false, error: msg.error ?? { code: "auth_failed", message: "Gateway auth failed" } });
          return;
        }
        onConnected({ ws, done });
      }
    };

    ws.onerror = () => {
      done({ ok: false, error: { code: "ws_error", message: "WebSocket connection failed" } });
    };

    ws.onclose = (e: CloseEvent) => {
      done({ ok: false, error: { code: "ws_closed", message: `WebSocket closed (code=${e.code})` } });
    };
  });
}

export function probeGatewayReady(token: string, timeoutMs = 10_000): Promise<RpcResult> {
  return connectGateway(token, timeoutMs, ({ done }) => {
    done({ ok: true });
  });
}

// Gateway WebSocket RPC 一次性调用（连接 → 握手 → 请求 → 关闭）
export function callGatewayRpc(
  method: string,
  params: Record<string, unknown>,
  token: string,
  timeoutMs = 10_000,
): Promise<RpcResult> {
  return connectGateway(token, timeoutMs, ({ ws, done }) => {
    const reqId = crypto.randomUUID();

    const onMessage = (event: MessageEvent) => {
      let raw: string;
      try {
        raw = decodeMessageData(event.data);
      } catch {
        return;
      }

      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === "res" && msg.id === reqId) {
        done({ ok: msg.ok, payload: msg.payload, error: msg.error });
      }
    };

    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ type: "req", id: reqId, method, params }));
  });
}
