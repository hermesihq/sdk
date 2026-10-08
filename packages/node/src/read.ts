/**
 * Turning what the server answered into the typed shapes this package returns.
 *
 * Each parser checks the one field a result cannot exist without and rejects with the same
 * `unexpected_response` error a non-JSON body gets, rather than inventing a half-empty result: a
 * success that is not shaped like one is the server (or a proxy) misbehaving, and the caller should
 * hear that, not read a made-up answer.
 */

import { errorFromResponse } from './errors.ts'
import type {
  BulkSubscribersResult,
  ChannelIdentity,
  EventRun,
  Message,
  MessageCreated,
  MessageResult,
  Preferences,
  RunNotification,
  SubscriberProfile,
} from './types.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function unexpected(status: number): Error {
  return errorFromResponse(status, null, null)
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : [])

function message(item: Record<string, unknown>): Message {
  const terminalAt = str(item.terminal_at)
  return {
    id: String(item.id),
    channel: String(item.channel),
    status: String(item.status),
    stepKey: str(item.step_key),
    provider: str(item.provider),
    failureCode: str(item.failure_code),
    failureMessage: str(item.failure_message),
    createdAt: str(item.created_at),
    terminalAt,
    isFinal: terminalAt !== null,
  }
}

export function parseMessage(body: unknown, status: number): Message {
  if (!isRecord(body) || typeof body.id !== 'string') throw unexpected(status)
  return message(body)
}

export function parseEventRun(body: unknown, status: number): EventRun {
  if (!isRecord(body) || typeof body.event_id !== 'string') throw unexpected(status)
  const notifications: RunNotification[] = records(body.notifications).map((n) => ({
    id: String(n.id),
    subscriberId: String(n.subscriber_id),
    externalId: String(n.external_id),
    workflow: str(n.workflow),
    workflowVersion: typeof n.workflow_version === 'number' ? n.workflow_version : null,
    status: String(n.status),
    createdAt: str(n.created_at),
    startedAt: str(n.started_at),
    completedAt: str(n.completed_at),
    resumeAt: str(n.resume_at),
    messages: records(n.messages).map(message),
  }))
  return {
    eventId: body.event_id,
    name: String(body.name),
    status: String(body.status),
    payload: isRecord(body.payload) ? body.payload : {},
    actor: isRecord(body.actor) ? body.actor : null,
    idempotencyKey: str(body.idempotency_key),
    error: isRecord(body.error) ? body.error : null,
    receivedAt: str(body.received_at),
    processedAt: str(body.processed_at),
    notifications,
    messages: notifications.flatMap((n) => n.messages),
  }
}

export function parseChannelIdentity(body: unknown, status: number): ChannelIdentity {
  if (!isRecord(body) || typeof body.identifier !== 'string') throw unexpected(status)
  return {
    channel: String(body.channel),
    identifier: body.identifier,
    state: typeof body.state === 'string' ? body.state : 'active',
    stateReason: str(body.state_reason),
    metadata: isRecord(body.metadata) ? body.metadata : {},
    verifiedAt: str(body.verified_at),
    lastUsedAt: str(body.last_used_at),
  }
}

function booleans(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (isRecord(value)) for (const [key, flag] of Object.entries(value)) out[key] = Boolean(flag)
  return out
}

export function parsePreferences(body: unknown, status: number): Preferences {
  if (!isRecord(body) || !isRecord(body.global)) throw unexpected(status)
  const categories: Record<string, Record<string, boolean>> = {}
  if (isRecord(body.categories)) for (const [key, channels] of Object.entries(body.categories)) categories[key] = booleans(channels)
  return { global: booleans(body.global), categories }
}

export function parseProfile(body: unknown, status: number): SubscriberProfile {
  if (!isRecord(body) || typeof body.external_id !== 'string') throw unexpected(status)
  return {
    id: String(body.id),
    externalId: body.external_id,
    email: str(body.email),
    phoneE164: str(body.phone_e164),
    firstName: str(body.first_name),
    lastName: str(body.last_name),
    locale: str(body.locale),
    timezone: str(body.timezone),
    avatarUrl: str(body.avatar_url),
    data: isRecord(body.data) ? body.data : {},
    createdAt: str(body.created_at),
    updatedAt: str(body.updated_at),
    channels: records(body.channels).map((c) => parseChannelIdentity(c, status)),
    preferences: parsePreferences(isRecord(body.preferences) ? body.preferences : { global: {}, categories: {} }, status),
  }
}

export function parseBulkResult(body: unknown, status: number): BulkSubscribersResult {
  if (!isRecord(body) || !Array.isArray(body.subscribers)) throw unexpected(status)
  return {
    created: typeof body.created === 'number' ? body.created : 0,
    updated: typeof body.updated === 'number' ? body.updated : 0,
    subscribers: records(body.subscribers).map((row) => ({
      externalId: String(row.external_id),
      id: String(row.id),
      status: String(row.status),
    })),
  }
}

export function parseMessageResult(body: unknown, status: number, replayed: boolean, idempotencyKey: string): MessageResult {
  if (!isRecord(body) || typeof body.message_id !== 'string') throw unexpected(status)
  const messages: MessageCreated[] = records(body.messages).map((m) => ({
    id: String(m.id),
    channel: String(m.channel),
    status: String(m.status),
    reason: str(m.reason),
  }))
  return { messageId: body.message_id, status: String(body.status), messages, replayed, idempotencyKey }
}
