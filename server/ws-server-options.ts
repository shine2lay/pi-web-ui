import type { ServerOptions } from "ws";
import { WS_MAX_PAYLOAD_BYTES } from "./files-service.js";

/**
 * The options of the app's one WebSocket server (`index.ts`), kept apart from the server start so a
 * test can build a server with exactly these (`tests/unit/ws-server-options.test.ts`).
 */
export const WS_SERVER_OPTIONS = Object.freeze({
	// index.ts takes each upgrade itself (origin and host checks first), then hands it to ws.
	noServer: true,
	// 右键上传走单帧 base64（100MB 文件 → ~133MB 文本）：上限与
	// files-service 的上传 cap 对齐（base64 上限 + 1MB 包络余量），
	// 超限帧由 ws 层直接拒收，不进 handler 再分配 Buffer。
	maxPayload: WS_MAX_PAYLOAD_BYTES,
	// ws-deflate-off (Ops #696): frames go out uncompressed. With `{ threshold: 16 * 1024 }`, ws
	// compressed EVERY frame, pings included: it honours the threshold only when the browser agrees
	// to server_no_context_takeover, and Chrome never asks for it (ws lib/sender.js). Each
	// compression takes several zlib thread-pool round trips, each waiting for a turn of the main
	// thread, which is busy with every other chat: on the live server a chat's snapshot took
	// 2.3-3.5 s to leave instead of 0.2 s, and a ping 774 ms instead of 116 ms (#689). The cost is
	// bytes on the wire: a big snapshot goes out at its full size.
	perMessageDeflate: false,
} satisfies ServerOptions);
