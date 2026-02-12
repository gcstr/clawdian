/**
 * Device identity crypto using Ed25519.
 *
 * The OpenClaw gateway expects:
 * - publicKey: base64url-encoded raw 32-byte Ed25519 public key
 * - deviceId: SHA-256 hex of the raw 32-byte public key
 * - signature: base64url-encoded Ed25519 signature of the auth payload
 *
 * Auth payload format (pipe-delimited):
 *   v2|{deviceId}|{clientId}|{clientMode}|{role}|{scopes}|{signedAtMs}|{token}|{nonce}
 *   v1|{deviceId}|{clientId}|{clientMode}|{role}|{scopes}|{signedAtMs}|{token}
 */

export interface StoredKeypair {
	publicKey: string;  // base64url raw 32-byte Ed25519 key
	privateKey: string; // base64url PKCS8 Ed25519 key
	deviceId: string;   // 64-char hex SHA-256 of raw public key
	algorithm: "Ed25519"; // key algorithm marker for migration
}

export interface AuthPayloadParams {
	deviceId: string;
	clientId: string;
	clientMode: string;
	role: string;
	scopes: string[];
	signedAtMs: number;
	token?: string | null;
	nonce?: string | null;
}

export async function generateKeypair(): Promise<StoredKeypair> {
	const keypair = await crypto.subtle.generateKey(
		"Ed25519" as unknown as AlgorithmIdentifier,
		true,
		["sign", "verify"]
	) as CryptoKeyPair;

	const publicKeyRaw = await crypto.subtle.exportKey("raw", keypair.publicKey);
	const privateKeyDer = await crypto.subtle.exportKey("pkcs8", keypair.privateKey);

	const publicKey = arrayBufferToBase64Url(publicKeyRaw);
	const privateKey = arrayBufferToBase64Url(privateKeyDer);
	const deviceId = await deriveDeviceId(publicKeyRaw);

	return { publicKey, privateKey, deviceId, algorithm: "Ed25519" };
}

export function buildAuthPayload(params: AuthPayloadParams): string {
	const version = params.nonce ? "v2" : "v1";
	const scopes = params.scopes.join(",");
	const token = params.token ?? "";
	const base = [
		version,
		params.deviceId,
		params.clientId,
		params.clientMode,
		params.role,
		scopes,
		String(params.signedAtMs),
		token,
	];
	if (version === "v2") {
		base.push(params.nonce ?? "");
	}
	return base.join("|");
}

export async function signPayload(
	privateKeyB64Url: string,
	data: string
): Promise<string> {
	const keyData = base64UrlToArrayBuffer(privateKeyB64Url);
	const key = await crypto.subtle.importKey(
		"pkcs8",
		keyData,
		"Ed25519" as unknown as AlgorithmIdentifier,
		false,
		["sign"]
	);

	const encoded = new TextEncoder().encode(data);
	const signature = await crypto.subtle.sign(
		"Ed25519" as unknown as AlgorithmIdentifier,
		key,
		encoded
	);
	return arrayBufferToBase64Url(signature);
}

async function deriveDeviceId(publicKeyRaw: ArrayBuffer): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", publicKeyRaw);
	const bytes = new Uint8Array(hash);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// --- Base64url encoding (RFC 4648 §5) ---

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToArrayBuffer(b64url: string): ArrayBuffer {
	const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}
