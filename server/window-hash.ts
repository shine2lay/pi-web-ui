/**
 * switch-cache：一截消息的指纹 —— 客户端缓存里的那一截，和服务端现在的消息还对得上吗。
 *
 * 客户端切回一条看过的对话时报上「我手里有 [start, start+count) 这一截，指纹是 h」；
 * 服务端对自己当前消息的同一截算同样的指纹，一样就只发后面新增的部分
 * （ClientSession.resumeWindow）。持久化的消息内容不可变、id 稳定，id 串一样 = 内容一样。
 *
 * cyrb53（53 位，碰撞概率可以不计），纯函数、不碰 Node：服务端和前端共用这一份。
 */
export function messagesHash(messages: readonly { id: string }[], from = 0, to = messages.length): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = from; i < to; i++) {
		const id = messages[i].id;
		for (let j = 0; j <= id.length; j++) {
			// 每个 id 后面补一个分隔符（\n），["ab","c"] 和 ["a","bc"] 就不会撞。
			const ch = j < id.length ? id.charCodeAt(j) : 10;
			h1 = Math.imul(h1 ^ ch, 2654435761);
			h2 = Math.imul(h2 ^ ch, 1597334677);
		}
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
