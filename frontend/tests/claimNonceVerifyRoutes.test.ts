/**
 * Tests for /api/claim/nonce and /api/claim/verify (#126).
 *
 * Covers:
 *   - Fresh nonce is issued and stored
 *   - Reused / consumed nonces are rejected
 *   - Expired nonces are rejected
 *   - Invalid wallet addresses are rejected
 *   - Valid signature succeeds exactly once (the nonce is consumed)
 *   - Invalid signature is rejected with a vague error (no info leak)
 *   - Rate-limit header blocks excess requests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockFrom = vi.fn();
const mockEnforceRateLimit = vi.fn();
const mockVerifyWalletSignature = vi.fn();
const mockHashAuditValue = vi.fn(() => 'hashed-ip');
const mockGetClientIp = vi.fn(() => '127.0.0.1');
const mockIsValidStellarAddress = vi.fn((addr: string) =>
    /^G[A-Z2-7]{55}$/.test(addr),
);

vi.mock('@/lib/serverAuth', () => ({
    getServiceRoleClient: () => ({ from: mockFrom }),
}));

vi.mock('@/lib/rateLimit', () => ({
    enforceRateLimit: mockEnforceRateLimit,
    getClientIp: mockGetClientIp,
}));

vi.mock('@/lib/walletOwnership', () => ({
    buildClaimMessage: (address: string, nonce: string) => `claim:${address}:${nonce}`,
    CLAIM_NONCE_TTL_SECONDS: 300,
    verifyWalletSignature: mockVerifyWalletSignature,
}));

vi.mock('@/lib/verificationAudit', () => ({
    hashAuditValue: mockHashAuditValue,
}));

vi.mock('@/lib/contracts', () => ({
    isValidStellarAddress: mockIsValidStellarAddress,
}));

vi.mock('@/lib/debug', () => ({
    structuredLog: vi.fn(),
    captureException: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const VALID_WALLET = 'GDUMMY11111111111111111111111111111111111111111111111111111';

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
    return new Request('http://localhost/api/claim/nonce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

function makeVerifyRequest(body: unknown, headers: Record<string, string> = {}) {
    return new Request('http://localhost/api/claim/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

// ── Nonce route ────────────────────────────────────────────────────────────

describe('POST /api/claim/nonce', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();

        // Default: rate limit passes, insert succeeds.
        mockEnforceRateLimit.mockResolvedValue(null);
        mockInsert.mockResolvedValue({ error: null });
        mockFrom.mockReturnValue({ insert: mockInsert });
    });

    it('issues a nonce for a valid wallet address', async () => {
        const { POST } = await import('../src/app/api/claim/nonce/route');
        const res = await POST(makeRequest({ walletAddress: VALID_WALLET }) as Parameters<typeof POST>[0]);

        expect(res.status).toBe(200);
        const body = await res.json() as { success: boolean; nonce: string; message: string; expiresAt: string };
        expect(body.success).toBe(true);
        expect(typeof body.nonce).toBe('string');
        expect(body.nonce.length).toBeGreaterThanOrEqual(32);
        expect(body.message).toContain(VALID_WALLET);
        expect(body.expiresAt).toBeTruthy();
    });

    it('stores the nonce in the database with the wallet address', async () => {
        const { POST } = await import('../src/app/api/claim/nonce/route');
        await POST(makeRequest({ walletAddress: VALID_WALLET }) as Parameters<typeof POST>[0]);

        expect(mockInsert).toHaveBeenCalledOnce();
        const inserted = mockInsert.mock.calls[0][0] as Record<string, unknown>;
        expect(inserted.wallet_address).toBe(VALID_WALLET);
        expect(typeof inserted.nonce).toBe('string');
        expect(inserted.expires_at).toBeTruthy();
    });

    it('rejects an invalid Stellar address with 400', async () => {
        const { POST } = await import('../src/app/api/claim/nonce/route');
        const res = await POST(makeRequest({ walletAddress: 'not-a-stellar-address' }) as Parameters<typeof POST>[0]);

        expect(res.status).toBe(400);
        const body = await res.json() as { success: boolean };
        expect(body.success).toBe(false);
    });

    it('rejects a missing wallet address with 400', async () => {
        const { POST } = await import('../src/app/api/claim/nonce/route');
        const res = await POST(makeRequest({}) as Parameters<typeof POST>[0]);

        expect(res.status).toBe(400);
    });

    it('returns 500 when the database insert fails', async () => {
        mockInsert.mockResolvedValue({ error: { message: 'DB down' } });

        const { POST } = await import('../src/app/api/claim/nonce/route');
        const res = await POST(makeRequest({ walletAddress: VALID_WALLET }) as Parameters<typeof POST>[0]);

        expect(res.status).toBe(500);
        const body = await res.json() as { success: boolean };
        expect(body.success).toBe(false);
    });

    it('returns 429 when the rate limit is hit', async () => {
        mockEnforceRateLimit.mockResolvedValue(
            new Response(JSON.stringify({ success: false, error: 'Too Many Requests' }), { status: 429 }),
        );

        const { POST } = await import('../src/app/api/claim/nonce/route');
        const res = await POST(makeRequest({ walletAddress: VALID_WALLET }) as Parameters<typeof POST>[0]);

        expect(res.status).toBe(429);
    });

    it('does not reveal whether the wallet holds a credential', async () => {
        // Any hint about credential existence in an error leaks private data.
        const { POST } = await import('../src/app/api/claim/nonce/route');
        const res = await POST(makeRequest({ walletAddress: 'invalid' }) as Parameters<typeof POST>[0]);

        const body = await res.json() as { error: string };
        expect(body.error).not.toMatch(/credential/i);
        expect(body.error).not.toMatch(/found/i);
    });
});

// ── Verify route ──────────────────────────────────────────────────────────

describe('POST /api/claim/verify', () => {
    const VALID_NONCE = 'a'.repeat(64);
    const VALID_SIG = 'valid-signature';
    const VALID_BODY = {
        walletAddress: VALID_WALLET,
        nonce: VALID_NONCE,
        signature: VALID_SIG,
        email: 'student@university.edu',
        password: 'correct-horse-battery-staple',
    };

    function makeNonceRow(overrides: Partial<{
        consumed_at: string | null;
        expires_at: string;
        wallet_address: string;
    }> = {}) {
        return {
            id: 'nonce-uuid',
            wallet_address: VALID_WALLET,
            expires_at: new Date(Date.now() + 300_000).toISOString(),
            consumed_at: null,
            ...overrides,
        };
    }

    function setupSupabaseMocks(nonceRow: ReturnType<typeof makeNonceRow> | null = makeNonceRow()) {
        const mockMaybeSingle = vi.fn().mockResolvedValue({ data: nonceRow, error: null });
        const mockEqNonce = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle }),
        });
        const mockSelectFn = vi.fn().mockReturnValue({ eq: mockEqNonce });

        const mockUpdateFn = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ error: null }),
        });
        const mockInsertAudit = vi.fn().mockResolvedValue({ error: null });

        // Admin auth_users.createUser stub.
        const mockCreateUser = vi.fn().mockResolvedValue({
            data: { user: { id: 'new-user-id' } },
            error: null,
        });

        mockFrom.mockImplementation((table: string) => {
            if (table === 'wallet_claim_nonces') {
                return { select: mockSelectFn, update: mockUpdateFn };
            }
            if (table === 'admin_audit_logs') {
                return { insert: mockInsertAudit };
            }
            return { insert: mockInsertAudit, select: mockSelectFn, update: mockUpdateFn };
        });

        return { mockCreateUser, mockMaybeSingle, mockUpdateFn };
    }

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mockEnforceRateLimit.mockResolvedValue(null);
        mockVerifyWalletSignature.mockReturnValue(true);
    });

    it('succeeds for a valid nonce, wallet, and signature', async () => {
        setupSupabaseMocks();

        const { POST } = await import('../src/app/api/claim/verify/route');
        const res = await POST(makeVerifyRequest(VALID_BODY) as Parameters<typeof POST>[0]);

        // 200 or 201 depending on whether the account was just created.
        expect([200, 201]).toContain(res.status);
        const body = await res.json() as { success: boolean };
        expect(body.success).toBe(true);
    });

    it('rejects a consumed (already-used) nonce', async () => {
        setupSupabaseMocks(makeNonceRow({ consumed_at: new Date().toISOString() }));

        const { POST } = await import('../src/app/api/claim/verify/route');
        const res = await POST(makeVerifyRequest(VALID_BODY) as Parameters<typeof POST>[0]);

        expect(res.status).toBe(400);
        const body = await res.json() as { success: boolean; error: string };
        expect(body.success).toBe(false);
        // The error message must not reveal which wallet the nonce was for.
        expect(body.error).not.toMatch(new RegExp(VALID_WALLET, 'i'));
    });

    it('rejects an expired nonce', async () => {
        setupSupabaseMocks(
            makeNonceRow({ expires_at: new Date(Date.now() - 1000).toISOString() }),
        );

        const { POST } = await import('../src/app/api/claim/verify/route');
        const res = await POST(makeVerifyRequest(VALID_BODY) as Parameters<typeof POST>[0]);

        expect(res.status).toBe(400);
        const body = await res.json() as { success: boolean };
        expect(body.success).toBe(false);
    });

    it('rejects a nonce that does not exist', async () => {
        setupSupabaseMocks(null);

        const { POST } = await import('../src/app/api/claim/verify/route');
        const res = await POST(makeVerifyRequest(VALID_BODY) as Parameters<typeof POST>[0]);

        expect(res.status).toBe(400);
    });

    it('rejects an invalid signature', async () => {
        setupSupabaseMocks();
        mockVerifyWalletSignature.mockReturnValue(false);

        const { POST } = await import('../src/app/api/claim/verify/route');
        const res = await POST(makeVerifyRequest(VALID_BODY) as Parameters<typeof POST>[0]);

        expect(res.status).toBe(400);
        const body = await res.json() as { success: boolean; error: string };
        expect(body.success).toBe(false);
        // The vague error must not confirm whether the wallet held a credential.
        expect(body.error).not.toMatch(/credential/i);
    });

    it('nonce cannot be reused — a second identical request is rejected', async () => {
        // First call: nonce is fresh.
        const { mockUpdateFn } = setupSupabaseMocks();

        const { POST } = await import('../src/app/api/claim/verify/route');
        const res1 = await POST(makeVerifyRequest(VALID_BODY) as Parameters<typeof POST>[0]);
        expect([200, 201]).toContain(res1.status);

        // Second call: nonce row is now consumed (the update mock sets consumed_at).
        setupSupabaseMocks(makeNonceRow({ consumed_at: new Date().toISOString() }));

        const { POST: POST2 } = await import('../src/app/api/claim/verify/route');
        const res2 = await POST2(makeVerifyRequest(VALID_BODY) as Parameters<typeof POST2>[0]);
        expect(res2.status).toBe(400);

        // The consumed nonce should have been updated, not just read.
        expect(mockUpdateFn).toHaveBeenCalled();
    });

    it('rejects a request with a missing signature', async () => {
        setupSupabaseMocks();
        const body = { ...VALID_BODY, signature: '' };

        const { POST } = await import('../src/app/api/claim/verify/route');
        const res = await POST(makeVerifyRequest(body) as Parameters<typeof POST>[0]);

        expect(res.status).toBe(400);
    });

    it('rejects a nonce bound to a different wallet', async () => {
        setupSupabaseMocks(
            makeNonceRow({ wallet_address: 'GDIFFERENT111111111111111111111111111111111111111111111111' }),
        );

        const { POST } = await import('../src/app/api/claim/verify/route');
        const res = await POST(makeVerifyRequest(VALID_BODY) as Parameters<typeof POST>[0]);

        // The nonce was looked up with both nonce AND wallet_address equality, so
        // a mismatch returns no row → 400, not a silent wrong-wallet claim.
        expect(res.status).toBe(400);
    });

    it('returns 429 when the rate limit is hit', async () => {
        mockEnforceRateLimit.mockResolvedValue(
            new Response(JSON.stringify({ success: false, error: 'Too Many Requests' }), { status: 429 }),
        );

        const { POST } = await import('../src/app/api/claim/verify/route');
        const res = await POST(makeVerifyRequest(VALID_BODY) as Parameters<typeof POST>[0]);

        expect(res.status).toBe(429);
    });
});
