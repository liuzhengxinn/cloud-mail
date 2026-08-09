import BizError from '../error/biz-error';

/**
 * Cross-device drafts, stored as one JSON array per user in KV.
 *
 * Attachments are deliberately not persisted: they arrive as base64 and would
 * blow past the 25 MiB KV value limit, so the client keeps them in memory only.
 */

const DRAFT_PREFIX = 'DRAFT_';
const MAX_DRAFTS = 100;
const MAX_BYTES = 1024 * 1024;

const draftService = {

	key(userId) {
		return DRAFT_PREFIX + userId;
	},

	async list(c, userId) {
		const data = await c.env.kv.get(this.key(userId), { type: 'json' });
		return Array.isArray(data) ? data : [];
	},

	async set(c, params, userId) {
		const draft = params || {};
		if (!draft.draftId) {
			throw new BizError('draftId required');
		}
		const list = await this.list(c, userId);
		const filtered = list.filter(d => String(d.draftId) !== String(draft.draftId));
		filtered.unshift(draft);

		// Cap by count first, then trim the oldest until the value fits KV.
		let capped = filtered.slice(0, MAX_DRAFTS);
		let json = JSON.stringify(capped);
		while (json.length > MAX_BYTES && capped.length > 1) {
			capped = capped.slice(0, capped.length - 1);
			json = JSON.stringify(capped);
		}

		await c.env.kv.put(this.key(userId), json);
		return draft;
	},

	async delete(c, params, userId) {
		const { draftId } = params;
		const list = await this.list(c, userId);
		const filtered = list.filter(d => String(d.draftId) !== String(draftId));
		await c.env.kv.put(this.key(userId), JSON.stringify(filtered));
	}
};

export default draftService;
