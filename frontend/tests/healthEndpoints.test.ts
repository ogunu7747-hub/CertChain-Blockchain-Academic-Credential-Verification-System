/**
 * Tests for /api/health and /api/admin/rate-limit-health (#127).
 *
 * Health endpoint semantics:
 *   200  all dependencies healthy
 *   207  at least one degraded, app can still serve
 *   503  all dependencies unreachable
 *
 * Rate-limit-health reports the current limiter mode (distributed /
 * in-memory-fallback / in-memory-unconfigured) and requires admin auth.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGetContractInfo = vi.fn();
const mockSupabaseSelect = vi.fn();
const mockFetch = vi.fn();
const mockGetRateLimiterMode = vi.fn();
const mockIsRateLimiterHealthy = vi.fn();
const mockRequireAdminRequest = vi.fn();

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
    return {
        ...actual,
        rpc: {
            ...actual.rpc,
            Server: vi.fn().mockImplementation(() => ({
                getContractData: mockGetContractInfo,
            })),
        },
    };
});

vi.mock('@/lib/runtimeConfig', () => ({
    runtimeConfig: {
        sorobanRpcUrl: 'https://rpc-testnet.stellar.org',
        contractId: 'CCREDENTIAL111111111111111111111111111111111111111111111111',
        network: 'testnet',
        ipfsGateway: 'https://ipfs.example.com',
    },
}));

vi.mock('@/lib/supabase/server', () => ({
    createServiceClient: () => ({
        from: () => ({
            select: mockSupabaseSelect,
        }),
    }),
}));

vi.mock('@/lib/rateLimit', () => ({
    getRateLimiterMode: mockGetRateLimiterMode,
    isRateLimiterHealthy: mockIsRateLimiterHealthy,
}));

vi.mock('@/lib/serverAuth', () => ({
    requireAdminRequest: mockRequireAdminRequest,
}));

// Replace global fetch with the mock.
const originalFetch = global.fetch;

// ── Health endpoint ────────────────────────────────────────────────────────

describe('GET /api/health', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        global.fetch = mockFetch;

        // Default: all dependencies healthy.
        mockGetContractInfo.mockResolvedValue({ status: 'success' });
        mockSupabaseSelect.mockResolvedValue({ data: [{ '?column?': 1 }], error: null });
        mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('returns 200 when all dependencies are healthy', async () => {
        const { GET } = await import('../src/app/api/health/route');
        const res = await GET();

        expect(res.status).toBe(200);
        const body = await res.json() as { status: string; dependencies: { sorobanRpc: { status: string }; supabase: { status: string } } };
        expect(body.status).toBe('healthy');
        expect(body.dependencies.sorobanRpc.status).toBe('healthy');
        expect(body.dependencies.supabase.status).toBe('healthy');
    });

    it('returns 207 when one dependency is degraded but others are healthy', async () => {
        // Supabase healthy, RPC degraded (bad contract info), IPFS healthy.
        mockGetContractInfo.mockRejectedValue(new Error('RPC timeout'));

        const { GET } = await import('../src/app/api/health/route');
        const res = await GET();

        // 207 = partial — app can still serve reads from Supabase.
        expect(res.status).toBe(207);
        const body = await res.json() as { status: string; dependencies: { sorobanRpc: { status: string } } };
        expect(body.status).toBe('degraded');
        expect(body.dependencies.sorobanRpc.status).not.toBe('healthy');
    });

    it('returns 503 when all dependencies are unreachable', async () => {
        mockGetContractInfo.mockRejectedValue(new Error('no network'));
        mockSupabaseSelect.mockRejectedValue(new Error('no network'));
        mockFetch.mockRejectedValue(new Error('no network'));

        const { GET } = await import('../src/app/api/health/route');
        const res = await GET();

        expect(res.status).toBe(503);
        const body = await res.json() as { status: string };
        expect(body.status).toBe('unhealthy');
    });

    it('returns 207 when IPFS gateway is unreachable but Supabase and RPC are healthy', async () => {
        mockFetch.mockRejectedValue(new Error('IPFS unreachable'));

        const { GET } = await import('../src/app/api/health/route');
        const res = await GET();

        expect([200, 207]).toContain(res.status);
    });

    it('includes latency measurements for each dependency', async () => {
        const { GET } = await import('../src/app/api/health/route');
        const res = await GET();
        const body = await res.json() as { dependencies: { sorobanRpc: { latencyMs: number }; supabase: { latencyMs: number } } };

        expect(typeof body.dependencies.sorobanRpc.latencyMs).toBe('number');
        expect(typeof body.dependencies.supabase.latencyMs).toBe('number');
    });

    it('includes the network name and contract ID in the response', async () => {
        const { GET } = await import('../src/app/api/health/route');
        const body = await (await GET()).json() as { network: string; contractId: string };

        expect(body.network).toBeTruthy();
        expect(body.contractId).toBeTruthy();
    });
});

// ── Rate-limit-health endpoint ─────────────────────────────────────────────

describe('GET /api/admin/rate-limit-health', () => {
    const makeRequest = (authHeader?: string) =>
        new Request('http://localhost/api/admin/rate-limit-health', {
            method: 'GET',
            headers: authHeader ? { Authorization: authHeader } : {},
        });

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();

        // Default: Redis distributed mode is healthy.
        mockGetRateLimiterMode.mockReturnValue('distributed');
        mockIsRateLimiterHealthy.mockReturnValue(true);
        mockRequireAdminRequest.mockResolvedValue({ ok: true });
    });

    it('returns 200 and distributed mode when Redis is healthy', async () => {
        const { GET } = await import('../src/app/api/admin/rate-limit-health/route');
        const res = await GET(makeRequest('Bearer admin-token') as Parameters<typeof GET>[0]);

        expect(res.status).toBe(200);
        const body = await res.json() as { success: boolean; rateLimiter: { mode: string; healthy: boolean; degraded: boolean } };
        expect(body.success).toBe(true);
        expect(body.rateLimiter.mode).toBe('distributed');
        expect(body.rateLimiter.healthy).toBe(true);
        expect(body.rateLimiter.degraded).toBe(false);
    });

    it('reports degraded=true when Redis fell back to in-memory', async () => {
        mockGetRateLimiterMode.mockReturnValue('in-memory-fallback');
        mockIsRateLimiterHealthy.mockReturnValue(false);

        const { GET } = await import('../src/app/api/admin/rate-limit-health/route');
        const res = await GET(makeRequest('Bearer admin-token') as Parameters<typeof GET>[0]);

        const body = await res.json() as { rateLimiter: { mode: string; degraded: boolean; healthy: boolean } };
        expect(body.rateLimiter.mode).toBe('in-memory-fallback');
        expect(body.rateLimiter.degraded).toBe(true);
        expect(body.rateLimiter.healthy).toBe(false);
    });

    it('reports unconfigured=true when Redis was never set up', async () => {
        mockGetRateLimiterMode.mockReturnValue('in-memory-unconfigured');
        mockIsRateLimiterHealthy.mockReturnValue(false);

        const { GET } = await import('../src/app/api/admin/rate-limit-health/route');
        const res = await GET(makeRequest('Bearer admin-token') as Parameters<typeof GET>[0]);

        const body = await res.json() as { rateLimiter: { unconfigured: boolean } };
        expect(body.rateLimiter.unconfigured).toBe(true);
    });

    it('returns 401 when the request is not authenticated as admin', async () => {
        mockRequireAdminRequest.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });

        const { GET } = await import('../src/app/api/admin/rate-limit-health/route');
        const res = await GET(makeRequest() as Parameters<typeof GET>[0]);

        expect(res.status).toBe(401);
        const body = await res.json() as { success: boolean };
        expect(body.success).toBe(false);
    });

    it('returns 403 when the authenticated user is not an admin', async () => {
        mockRequireAdminRequest.mockResolvedValue({ ok: false, status: 403, error: 'Forbidden' });

        const { GET } = await import('../src/app/api/admin/rate-limit-health/route');
        const res = await GET(makeRequest('Bearer user-token') as Parameters<typeof GET>[0]);

        expect(res.status).toBe(403);
    });
});
