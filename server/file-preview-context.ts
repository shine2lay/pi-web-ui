import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { FilePreviewBinding, FilePreviewMetadata } from "./protocol.js";

const FIELDS = ["reqId", "purpose", "binding", "lifetime", "revision"] as const;
const own = (object: object, key: string): unknown => Object.getOwnPropertyDescriptor(object, key)?.value;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Parsed transport metadata is copied before IO. Invalid metadata must not become a legacy write. */
export function snapshotFileMetadata(request?: FilePreviewMetadata) {
	const value: FilePreviewMetadata = {};
	let present = false;
	let valid = true;
	if (!request) return { value, present, valid };
	for (const key of FIELDS) {
		const descriptor = Object.getOwnPropertyDescriptor(request, key);
		if (!descriptor) continue;
		present = true;
		if (!("value" in descriptor)) {
			valid = false;
			continue;
		}
		const field: unknown = descriptor.value;
		if (key === "binding") {
			if (!field || typeof field !== "object" || Array.isArray(field)) {
				valid = false;
				continue;
			}
			const workspaceId = own(field, "workspaceId");
			const openId = own(field, "openId");
			const sessionId = own(field, "sessionId");
			const resourceId = own(field, "resourceId");
			if (
				!nonempty(workspaceId) ||
				!nonempty(openId) ||
				(sessionId !== undefined && !nonempty(sessionId)) ||
				(resourceId !== undefined && !nonempty(resourceId))
			) {
				valid = false;
				continue;
			}
			value.binding = Object.freeze({
				workspaceId,
				openId,
				...(sessionId === undefined ? {} : { sessionId }),
				...(resourceId === undefined ? {} : { resourceId }),
			});
		} else if (key === "revision") {
			if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) valid = false;
			else value.revision = field;
		} else if (key === "purpose") {
			if (field !== "read" && field !== "write") valid = false;
			else value.purpose = field;
		} else if (nonempty(field)) value[key] = field;
		else valid = false;
	}
	return { value: Object.freeze(value), present, valid };
}

export type FileMetadataSnapshot = ReturnType<typeof snapshotFileMetadata>;
export interface PreviewTarget {
	readonly absolutePath: string;
	readonly resourceId: string;
	readonly stat: fs.Stats;
	readonly reply: FilePreviewMetadata;
}

/** Called synchronously before the first await. Existing caller path authorization is unchanged. */
export function capturePreviewTarget(
	absolutePath: string,
	workspaceId: string,
	sessionId: string | undefined,
	purpose: "read" | "write",
	metadata: FileMetadataSnapshot,
): PreviewTarget {
	const expected = metadata.value;
	if (
		metadata.present &&
		(!metadata.valid ||
			!expected.reqId ||
			!expected.lifetime ||
			expected.revision === undefined ||
			expected.purpose !== purpose ||
			!expected.binding ||
			expected.binding.workspaceId !== workspaceId ||
			expected.binding.sessionId !== sessionId)
	)
		throw new Error("File preview context changed or is incomplete; reopen the original file.");
	const physicalPath = fs.realpathSync(absolutePath);
	const stat = fs.statSync(physicalPath);
	if (!stat.isFile()) throw new Error("Not a file.");
	// Physical path, not a client-chosen path label. Atomic replacement keeps this resource stable.
	const resourceId = `file:${createHash("sha256").update(physicalPath).digest("hex")}`;
	if (
		metadata.present &&
		((purpose === "write" && !expected.binding?.resourceId) ||
			(expected.binding?.resourceId !== undefined && expected.binding.resourceId !== resourceId))
	)
		throw new Error("The resolved file changed; reopen it before writing.");
	const binding: FilePreviewBinding | undefined =
		expected.binding && Object.freeze({ ...expected.binding, resourceId });
	return Object.freeze({
		absolutePath: physicalPath,
		resourceId,
		stat,
		reply: Object.freeze({ ...expected, purpose, ...(binding ? { binding } : {}) }),
	});
}

type ReplaceIO = Pick<
	typeof fs,
	| "openSync"
	| "closeSync"
	| "writeFileSync"
	| "fstatSync"
	| "fchownSync"
	| "fchmodSync"
	| "fsyncSync"
	| "readFileSync"
	| "renameSync"
	| "unlinkSync"
>;

/** No truncation of the original. A post-rename error is uncertain, never reported as a successful save. */
export function replacePreviewText(target: PreviewTarget, text: string, io: ReplaceIO = fs): void {
	// Replacing a directory entry must not bypass the original file's write permissions.
	fs.accessSync(target.absolutePath, fs.constants.W_OK);
	const bytes = Buffer.from(text, "utf8");
	const temporary = join(dirname(target.absolutePath), `.pi-preview-${randomUUID()}.tmp`);
	let fd: number | undefined;
	let owned = false;
	try {
		fd = io.openSync(temporary, "wx", 0o600);
		owned = true;
		io.writeFileSync(fd, bytes);
		const created = io.fstatSync(fd);
		if (created.uid !== target.stat.uid || created.gid !== target.stat.gid)
			io.fchownSync(fd, target.stat.uid, target.stat.gid);
		// A content edit must not reintroduce setuid/setgid bits cleared by an ordinary write.
		io.fchmodSync(fd, target.stat.mode & 0o777);
		io.fsyncSync(fd);
		io.closeSync(fd);
		fd = undefined;
		if (!io.readFileSync(temporary).equals(bytes)) throw new Error("File preparation readback did not match.");
		io.renameSync(temporary, target.absolutePath);
		owned = false;
		// POSIX directory sync makes the rename durable. Windows does not expose a directory fd.
		if (process.platform !== "win32") {
			const directory = io.openSync(dirname(target.absolutePath), "r");
			try {
				io.fsyncSync(directory);
			} finally {
				io.closeSync(directory);
			}
		}
	} finally {
		if (fd !== undefined) io.closeSync(fd);
		if (owned) io.unlinkSync(temporary);
	}
}
