/**
 * FCM HTTP v1 push.
 *
 * Device tokens live in KV under DEVICE_<userId> (a small JSON array) rather
 * than D1: they churn constantly and are worthless if lost, so they are not
 * worth a table or a migration.
 *
 * Requires the `fcm_service_account` secret — the raw JSON of a Firebase
 * service account with the Firebase Cloud Messaging API enabled. Without it
 * every entry point here is a no-op, so the Worker still runs unconfigured.
 */

const DEVICE_PREFIX = 'DEVICE_';
const TOKEN_CACHE_KEY = 'FCM_ACCESS_TOKEN';
const MAX_DEVICES = 10;

function b64url(bytes) {
	let bin = '';
	const arr = new Uint8Array(bytes);
	for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj) {
	return btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
		.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem) {
	const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
	const bin = atob(body);
	const der = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
	return der.buffer;
}

const pushService = {

	enabled(c) {
		return !!c.env.fcm_service_account;
	},

	account(c) {
		return JSON.parse(c.env.fcm_service_account);
	},

	deviceKey(userId) {
		return DEVICE_PREFIX + userId;
	},

	async listDevices(c, userId) {
		const data = await c.env.kv.get(this.deviceKey(userId), { type: 'json' });
		return Array.isArray(data) ? data : [];
	},

	async register(c, params, userId) {
		const { token } = params;
		if (!token) return;
		let devices = await this.listDevices(c, userId);
		devices = devices.filter(d => d.token !== token);
		devices.unshift({ token, createTime: Date.now() });
		await c.env.kv.put(this.deviceKey(userId), JSON.stringify(devices.slice(0, MAX_DEVICES)));
	},

	async unregister(c, params, userId) {
		const { token } = params;
		const devices = await this.listDevices(c, userId);
		await c.env.kv.put(this.deviceKey(userId), JSON.stringify(devices.filter(d => d.token !== token)));
	},

	/** Google OAuth access token for FCM, cached in KV just under its 1h lifetime. */
	async getAccessToken(c) {
		const cached = await c.env.kv.get(TOKEN_CACHE_KEY);
		if (cached) return cached;

		const sa = this.account(c);
		const now = Math.floor(Date.now() / 1000);
		const header = b64urlJson({ alg: 'RS256', typ: 'JWT' });
		const claims = b64urlJson({
			iss: sa.client_email,
			scope: 'https://www.googleapis.com/auth/firebase.messaging',
			aud: sa.token_uri,
			iat: now,
			exp: now + 3600
		});
		const input = `${header}.${claims}`;
		const key = await crypto.subtle.importKey(
			'pkcs8',
			pemToDer(sa.private_key),
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
			false,
			['sign']
		);
		const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
		const jwt = `${input}.${b64url(sig)}`;

		const res = await fetch(sa.token_uri, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`
		});
		const data = await res.json();
		if (!data.access_token) throw new Error('FCM token exchange failed: ' + JSON.stringify(data));
		await c.env.kv.put(TOKEN_CACHE_KEY, data.access_token, { expirationTtl: 3300 });
		return data.access_token;
	},

	/** Notify all of the user's devices about a newly received email. Never throws. */
	async pushNewEmail(c, emailRow) {
		try {
			if (!this.enabled(c) || !emailRow?.userId) return;
			const devices = await this.listDevices(c, emailRow.userId);
			if (!devices.length) return;

			const accessToken = await this.getAccessToken(c);
			const sa = this.account(c);
			const sender = emailRow.name || emailRow.sendEmail || '新邮件';
			const title = String(sender).slice(0, 60);
			const body = (emailRow.subject || emailRow.text || '(无主题)').slice(0, 120);

			const stale = [];
			await Promise.all(devices.map(async d => {
				const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${accessToken}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						message: {
							token: d.token,
							notification: { title, body },
							data: {
								emailId: String(emailRow.emailId ?? ''),
								toEmail: String(emailRow.toEmail ?? '')
							},
							android: { priority: 'HIGH', notification: { channel_id: 'new_mail' } }
						}
					})
				});
				// 404 UNREGISTERED / 400 INVALID_ARGUMENT mean the token is dead.
				if (res.status === 404 || res.status === 400) stale.push(d.token);
			}));

			if (stale.length) {
				const alive = devices.filter(d => !stale.includes(d.token));
				await c.env.kv.put(this.deviceKey(emailRow.userId), JSON.stringify(alive));
			}
		} catch (e) {
			console.error('FCM push failed:', e);
		}
	},

	/**
	 * Push a batch of freshly inserted inbox rows. Used by on-site delivery,
	 * where one send fans out to several recipients at once.
	 */
	async pushNewEmails(c, emailRows) {
		if (!this.enabled(c)) return;
		const rows = (emailRows || []).filter(row => row && row.userId);
		if (!rows.length) return;
		await Promise.all(rows.map(row => this.pushNewEmail(c, row)));
	}
};

export default pushService;
