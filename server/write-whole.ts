// ---------------------------------------------------------------------------
// write-whole.ts — write a file whole, never half: a temporary file in the same folder, then a rename
// over the old one (as pi-identity's writeWhole). Moved out of identity-roles.ts so any store can use
// it (Ops #684: the owner-question hold store needs it with mode 0600).
// ---------------------------------------------------------------------------

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface WriteWholeOptions {
	/** The file's permission bits, exactly (0o600 for a private store); left out = a new file's default. */
	mode?: number;
}

/** Writes `text` to `path` whole (creating its folder). A failed write leaves the old file and no temporary one. */
export function writeWhole(path: string, text: string, options: WriteWholeOptions = {}): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		if (options.mode === undefined) writeFileSync(tmp, text, "utf8");
		else {
			writeFileSync(tmp, text, { encoding: "utf8", mode: options.mode });
			chmodSync(tmp, options.mode); // exactly these bits, whatever the umask
		}
		renameSync(tmp, path);
	} catch (err) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// the folder itself is gone or unusable: nothing was left there
		}
		throw err;
	}
}

/**
 * 转录整文件重写的原子落盘：先写同目录临时文件再 rename。转录是 append-only
 * 的唯一事实源，compaction 收尾/清理的整文件重写若中途被打断（进程被杀/断电），
 * 原地 writeFileSync 会留下截断的 JSONL；同目录 rename 是原子的，最坏情况是
 * 旧文件原样保留，绝不会出现半份转录。Windows 下目标被外部占用（阅读器/杀软
 * 锁）时 rename 可能 EPERM —— 退回原地写保住功能（旧行为），不因小概率锁失败丢更新。
 * (Moved here from agent-service.ts, Ops #1090: one home for whole-file writes.)
 */
export function atomicWriteFileSync(file: string, data: string): void {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tmp, data);
		try {
			renameSync(tmp, file);
		} catch {
			writeFileSync(file, data);
		}
	} finally {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// 临时文件清不掉只能留给下次（同目录 .tmp，不影响转录本身）
		}
	}
}
