/**
 * The commit route's optional { as_draft: true } body: it must reach the
 * executor as opts.asDraft, and anything else must keep the plain approval.
 * The executor behaviour itself is covered in
 * lib/pending-operations/__tests__/voucher-executors.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockCommit = vi.fn()
vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => mockCommit(...args),
}))

import { POST } from '../route'

const op = { id: 'op-1', company_id: 'company-1', operation_type: 'create_voucher', status: 'pending' }

describe('POST /api/pending-operations/:id/commit: as_draft', () => {
  const routeParams = createMockRouteParams({ id: 'op-1' })

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'a@b.se' } } })
    mockCommit.mockResolvedValue({ status: 'committed', data: { journal_entry_id: 'je-1', status: 'draft' } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const request = createMockRequest('/api/pending-operations/op-1/commit', {
      method: 'POST',
      body: { as_draft: true },
    })
    const { status } = await parseJsonResponse(await POST(request, routeParams))
    expect(status).toBe(401)
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('passes asDraft=true to the executor and returns the draft', async () => {
    enqueue({ data: op, error: null })
    const request = createMockRequest('/api/pending-operations/op-1/commit', {
      method: 'POST',
      body: { as_draft: true },
    })
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(
      await POST(request, routeParams)
    )
    expect(status).toBe(200)
    expect(body.data.status).toBe('draft')
    expect(mockCommit.mock.calls[0][4]).toMatchObject({ asDraft: true, commitMethod: 'user_accept' })
  })

  it('keeps the plain approval when there is no body', async () => {
    enqueue({ data: op, error: null })
    const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
    await POST(request, routeParams)
    expect(mockCommit.mock.calls[0][4]).toMatchObject({ asDraft: false })
  })

  it('keeps the plain approval unless as_draft is literally true', async () => {
    enqueue({ data: op, error: null })
    const request = createMockRequest('/api/pending-operations/op-1/commit', {
      method: 'POST',
      body: { as_draft: 'true' },
    })
    await POST(request, routeParams)
    expect(mockCommit.mock.calls[0][4]).toMatchObject({ asDraft: false })
  })

  it('returns the executor refusal unchanged (inbox-linked proposal stays pending)', async () => {
    enqueue({ data: op, error: null })
    mockCommit.mockResolvedValue({
      status: 'failed',
      error: 'Förslaget är kopplat till ett dokument i inkorgen och kan inte godkännas som utkast. Godkänn det direkt eller avvisa det.',
      http_status: 409,
      operation_status: 'pending',
    })
    const request = createMockRequest('/api/pending-operations/op-1/commit', {
      method: 'POST',
      body: { as_draft: true },
    })
    const { status } = await parseJsonResponse(await POST(request, routeParams))
    expect(status).toBe(409)
  })
})
