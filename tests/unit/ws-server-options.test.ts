/** ws-deflate-off (Ops #696): the app's WebSocket server sends every frame uncompressed, even to a
 *  browser that offers permessage-deflate the way Chrome does. A raw socket, so the test sees the
 *  handshake answer and each frame's compression bit (RSV1) exactly as the browser gets them. */
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { WS_SERVER_OPTIONS } from "../../server/ws-server-options.js";

/** Chrome's offer. It never asks for server_no_context_takeover, the only case in which ws honours
 *  a size threshold, so with compression on, every frame was compressed. */
const CHROME_EXTENSION_OFFER = "permessage-deflate; client_max_window_bits";
const SMALL_FRAME = JSON.stringify({ type: "pong" });
const BIG_FRAME = JSON.stringify({ type: "snapshot", text: "x".repeat(64 * 1024) });

type FrameBits = { rsv1: boolean; opcode: number };
type ChromeLikeOpen = { status: string; headers: Map<string, string>; frames: FrameBits[] };

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** The app's server options behind a loopback HTTP server that hands each upgrade to ws, as
 *  index.ts does. Every new connection gets a small frame, then a big one. */
async function startAppLikeServer(): Promise<{ port: number; offers: Array<string | undefined> }> {
	const wss = new WebSocketServer(WS_SERVER_OPTIONS);
	const offers: Array<string | undefined> = [];
	const http = createServer();
	http.on("upgrade", (req, socket, head) => {
		offers.push(req.headers["sec-websocket-extensions"]);
		wss.handleUpgrade(req, socket, head, (ws) => {
			ws.send(SMALL_FRAME);
			ws.send(BIG_FRAME);
		});
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => {
		for (const client of wss.clients) client.terminate();
		wss.close();
		http.closeAllConnections();
		http.close();
	});
	return { port: (http.address() as AddressInfo).port, offers };
}

/** The compression bit and opcode of each complete server-to-client (unmasked) frame in `bytes`. */
function readFrameBits(bytes: Buffer): FrameBits[] {
	const frames: FrameBits[] = [];
	let at = 0;
	while (bytes.length - at >= 2) {
		const first = bytes.readUInt8(at);
		let length = bytes.readUInt8(at + 1) & 0x7f;
		let headerLength = 2;
		if (length === 126) {
			if (bytes.length - at < 4) break;
			length = bytes.readUInt16BE(at + 2);
			headerLength = 4;
		} else if (length === 127) {
			if (bytes.length - at < 10) break;
			length = Number(bytes.readBigUInt64BE(at + 2));
			headerLength = 10;
		}
		if (bytes.length - at < headerLength + length) break;
		frames.push({ rsv1: (first & 0x40) !== 0, opcode: first & 0x0f });
		at += headerLength + length;
	}
	return frames;
}

/** Opens a WebSocket by hand with Chrome's extension offer, and reads the handshake answer and the
 *  first `count` frames. */
function openLikeChrome(port: number, count: number): Promise<ChromeLikeOpen> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1");
		cleanups.push(() => socket.destroy());
		let bytes = Buffer.alloc(0);
		let answer: { status: string; headers: Map<string, string> } | null = null;
		socket.on("error", reject);
		socket.on("connect", () => {
			socket.write(
				[
					"GET /ws HTTP/1.1",
					`Host: 127.0.0.1:${port}`,
					"Upgrade: websocket",
					"Connection: Upgrade",
					"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
					"Sec-WebSocket-Version: 13",
					`Sec-WebSocket-Extensions: ${CHROME_EXTENSION_OFFER}`,
					"",
					"",
				].join("\r\n"),
			);
		});
		socket.on("data", (chunk: Buffer) => {
			bytes = Buffer.concat([bytes, chunk]);
			if (!answer) {
				const end = bytes.indexOf("\r\n\r\n");
				if (end < 0) return;
				const [status = "", ...lines] = bytes.subarray(0, end).toString("latin1").split("\r\n");
				const headers = new Map(
					lines.map((line): [string, string] => {
						const colon = line.indexOf(":");
						return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
					}),
				);
				answer = { status, headers };
				bytes = bytes.subarray(end + 4);
			}
			const frames = readFrameBits(bytes);
			if (frames.length >= count) resolve({ ...answer, frames: frames.slice(0, count) });
		});
	});
}

describe("the app's WebSocket server options (ws-deflate-off)", () => {
	it("decline Chrome's permessage-deflate offer and send small and big frames uncompressed", async () => {
		const { port, offers } = await startAppLikeServer();
		const { status, headers, frames } = await openLikeChrome(port, 2);
		expect(status).toBe("HTTP/1.1 101 Switching Protocols");
		// Control: the offer reached the server, so a handshake answer without the extension means
		// the server declined it.
		expect(offers).toEqual([CHROME_EXTENSION_OFFER]);
		expect(headers.get("sec-websocket-extensions")).toBeUndefined();
		// Two text frames (opcode 1), compression bit clear: the pong-sized one and the 64 KB one.
		expect(frames).toEqual([
			{ rsv1: false, opcode: 1 },
			{ rsv1: false, opcode: 1 },
		]);
	});
});
