/**
 * slow-link.mjs: a small TCP proxy that puts a mobile-data link between a test browser and the test
 * server. Everything the page loads (HTML, scripts, the chat socket) goes through it.
 *
 *   const link = await startSlowLink({ target: srv.port });
 *   await page.goto(link.http);        // the page and its socket now use the slow link
 *   link.silence();                    // the connections open now go quiet: nothing arrives, nothing
 *                                      // closes, like a phone that dropped off Wi-Fi; new ones work
 *   link.offline(true);                // no network: new connections hang too; offline(false) ends it
 *   link.setSpeed({ downKbps, upKbps, rttMs })  // another link (setSpeed(null): full speed)
 *   link.stats()                       // { down, up, connections, open } bytes since the start
 *   await link.close();
 *
 * The defaults are a slow mobile-data link: 1.6 Mbit/s down, 750 kbit/s up, 150-300 ms round trip
 * (Lighthouse's "slow 4G"). One link for all connections, like one radio: parallel downloads share
 * the speed, and a big download delays the small messages queued behind it. Each connection gets
 * its own round trip in the range; bytes on one connection always arrive in order. When the queue
 * for a connection gets long, the proxy stops reading from the sender, so the sender's own buffers
 * fill as they would on a real slow link (the server's backpressure checks see a slow reader).
 */
import { createServer } from "node:net";
import { connect } from "node:net";

const PIECE = 16 * 1024;
const HIGH_WATER = 64 * 1024;
const LOW_WATER = 16 * 1024;

export const SLOW_4G = { downKbps: 1600, upKbps: 750, rttMs: [150, 300] };

export async function startSlowLink({ target, host = "127.0.0.1", ...speed } = {}) {
	let link = { ...SLOW_4G, ...speed };
	let offlineNow = false;
	const connections = new Set();
	const totals = { down: 0, up: 0, connections: 0 };
	// When the link is free again, per direction: one radio shared by every connection.
	const busyUntil = { down: 0, up: 0 };

	const rate = (dir) => (link ? (dir === "down" ? link.downKbps : link.upKbps) / 8 : Infinity); // bytes per ms
	const pickOneWay = () => {
		if (!link) return 0;
		const [lo, hi] = Array.isArray(link.rttMs) ? link.rttMs : [link.rttMs, link.rttMs];
		return (lo + Math.random() * (hi - lo)) / 2;
	};

	function lane(conn, dir, from, to) {
		const queue = []; // { at, buf }
		let queued = 0;
		let timer = null;
		let paused = false;
		const flush = () => {
			timer = null;
			if (conn.quiet) return;
			const now = performance.now();
			while (queue.length && queue[0].at <= now) {
				const { buf } = queue.shift();
				queued -= buf.length;
				totals[dir] += buf.length;
				if (!to.destroyed) to.write(buf);
			}
			if (paused && queued < LOW_WATER && !conn.quiet) {
				paused = false;
				from.resume();
			}
			if (queue.length) timer = setTimeout(flush, Math.max(0, queue[0].at - performance.now()));
		};
		from.on("data", (data) => {
			if (conn.quiet) return; // a silenced link loses everything
			const now = performance.now();
			for (let i = 0; i < data.length; i += PIECE) {
				const buf = data.subarray(i, i + PIECE);
				const r = rate(dir);
				// The piece goes out when the link is free, takes its size / speed, then travels.
				const start = Math.max(now, busyUntil[dir]);
				const sent = Number.isFinite(r) ? start + buf.length / r : now;
				busyUntil[dir] = sent;
				const at = Math.max(sent + conn.oneWay, queue.length ? queue[queue.length - 1].at : 0);
				queue.push({ at, buf });
				queued += buf.length;
			}
			if (queued > HIGH_WATER && !paused) {
				paused = true;
				from.pause();
			}
			if (!timer) timer = setTimeout(flush, Math.max(0, queue[0].at - performance.now()));
		});
		return {
			hush() {
				if (timer) clearTimeout(timer);
				timer = null;
				queue.length = 0;
				queued = 0;
				// Stop reading: the sender's buffers fill up, as on a link that went dead.
				from.pause();
			},
			// Close the far side once everything queued has arrived.
			end() {
				const done = () => {
					if (!queue.length) to.end();
					else setTimeout(done, 20);
				};
				done();
			},
		};
	}

	const server = createServer((client) => {
		const conn = { quiet: offlineNow, oneWay: pickOneWay(), client, upstream: null };
		connections.add(conn);
		totals.connections += 1;
		client.on("error", () => {});
		if (conn.quiet) {
			// No network: the connection opens (the phone thinks it has a link) and nothing ever comes.
			client.pause();
			client.on("close", () => connections.delete(conn));
			return;
		}
		const upstream = connect({ host, port: target });
		conn.upstream = upstream;
		upstream.on("error", () => client.destroy());
		upstream.setNoDelay(true);
		client.setNoDelay(true);
		conn.lanes = [lane(conn, "up", client, upstream), lane(conn, "down", upstream, client)];
		client.on("end", () => !conn.quiet && conn.lanes[0].end());
		upstream.on("end", () => !conn.quiet && conn.lanes[1].end());
		const gone = () => {
			connections.delete(conn);
			if (!conn.quiet) {
				client.destroy();
				upstream.destroy();
			}
		};
		client.on("close", gone);
		upstream.on("close", gone);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();

	return {
		port,
		http: `http://localhost:${port}`,
		ws: `ws://localhost:${port}/ws`,
		/** Every connection open now goes quiet: no bytes either way, no close, no error. */
		silence() {
			let n = 0;
			for (const conn of connections) {
				if (conn.quiet) continue;
				conn.quiet = true;
				for (const l of conn.lanes ?? []) l.hush();
				n += 1;
			}
			return n;
		},
		/** true: no network (new connections hang, open ones go quiet); false: the network is back. */
		offline(on) {
			offlineNow = Boolean(on);
			if (offlineNow) this.silence();
		},
		/** Another link speed; null = no shaping at all (full local speed). */
		setSpeed(next) {
			link = next ? { ...SLOW_4G, ...next } : null;
		},
		stats() {
			let open = 0;
			for (const c of connections) if (!c.quiet) open += 1;
			return { ...totals, open };
		},
		async close() {
			for (const conn of connections) {
				conn.client.destroy();
				conn.upstream?.destroy();
			}
			await new Promise((resolve) => server.close(() => resolve()));
		},
	};
}
