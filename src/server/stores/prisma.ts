// Prisma-backed Stores. Every query includes `userId` in its WHERE clause — the user id comes
// from the signed session, never from the model.

import type { Prisma, PrismaClient, Property as DbProperty, User as DbUser, PendingAction as DbPendingAction } from "@prisma/client";
import { bigIntToInr } from "@/domain/money";
import type { DiffEntry } from "@/domain/propertyChanges";
import type { Property, UserProfile } from "@/domain/types";
import type { PendingActionPayload, PendingActionRecord, Stores } from "./types";

type Db = PrismaClient | Prisma.TransactionClient;

const toBig = (n: number) => BigInt(n);
const toBigOrNull = (n: number | null | undefined) => (n === null || n === undefined ? n : BigInt(n));

export function mapProperty(p: DbProperty): Property {
  return {
    id: p.id,
    userId: p.userId,
    propertyTypeRaw: p.propertyTypeRaw,
    assetClass: p.assetClass,
    subType: p.subType,
    locationRaw: p.locationRaw,
    locality: p.locality,
    city: p.city,
    state: p.state,
    areaSqft: p.areaSqft,
    currentValueInr: bigIntToInr(p.currentValueInr),
    purchasePriceInr: p.purchasePriceInr === null ? null : bigIntToInr(p.purchasePriceInr),
    annualRentInr: bigIntToInr(p.annualRentInr),
    occupancyStatus: p.occupancyStatus,
    ownershipPercent: p.ownershipPercent,
    status: p.status,
    version: p.version,
  };
}

export function mapUser(u: DbUser): UserProfile {
  return {
    id: u.id,
    name: u.name,
    city: u.city,
    preferences: u.preferences,
    preferredLocations: u.preferredLocations,
    portfolioValuePreferenceRaw: u.portfolioValuePreferenceRaw,
    prefMinInr: u.prefMinInr === null ? null : bigIntToInr(u.prefMinInr),
    prefMaxInr: u.prefMaxInr === null ? null : bigIntToInr(u.prefMaxInr),
  };
}

function mapPending(a: DbPendingAction): PendingActionRecord {
  return {
    id: a.id,
    userId: a.userId,
    conversationId: a.conversationId,
    type: a.type,
    propertyId: a.propertyId,
    payload: a.payload as unknown as PendingActionPayload,
    diff: a.diff as unknown as DiffEntry[],
    expectedVersion: a.expectedVersion,
    status: a.status,
    createdInRunId: a.createdInRunId,
    expiresAt: a.expiresAt,
    createdAt: a.createdAt,
    resolvedAt: a.resolvedAt,
  };
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

function storesFor(db: Db, root: PrismaClient | null): Stores {
  const stores: Stores = {
    users: {
      async list() {
        return (await db.user.findMany({ orderBy: { id: "asc" } })).map(mapUser);
      },
      async get(userId) {
        const u = await db.user.findUnique({ where: { id: userId } });
        return u ? mapUser(u) : null;
      },
    },
    properties: {
      async listByUser(userId) {
        return (await db.property.findMany({ where: { userId }, orderBy: { createdAt: "asc" } })).map(mapProperty);
      },
      async getForUser(userId, propertyId) {
        const p = await db.property.findFirst({ where: { id: propertyId, userId } });
        return p ? mapProperty(p) : null;
      },
      async create(userId, data, audit) {
        const created = await db.property.create({
          data: {
            ...data,
            userId,
            currentValueInr: toBig(data.currentValueInr),
            annualRentInr: toBig(data.annualRentInr),
            purchasePriceInr: toBigOrNull(data.purchasePriceInr),
            source: "chat",
          },
        });
        const property = mapProperty(created);
        await db.propertyAudit.create({
          data: { propertyId: property.id, userId, action: "CREATE", after: json(property), pendingActionId: audit.pendingActionId },
        });
        return property;
      },
      async update(userId, propertyId, expectedVersion, patch, audit) {
        const before = await db.property.findFirst({ where: { id: propertyId, userId } });
        if (!before) return null;
        const { count } = await db.property.updateMany({
          where: { id: propertyId, userId, version: expectedVersion },
          data: {
            ...patch,
            currentValueInr: toBigOrNull(patch.currentValueInr) ?? undefined,
            annualRentInr: toBigOrNull(patch.annualRentInr) ?? undefined,
            purchasePriceInr: patch.purchasePriceInr === undefined ? undefined : toBigOrNull(patch.purchasePriceInr),
            version: { increment: 1 },
          },
        });
        if (count === 0) return "version_conflict";
        const after = mapProperty((await db.property.findFirst({ where: { id: propertyId, userId } }))!);
        await db.propertyAudit.create({
          data: {
            propertyId,
            userId,
            action: "UPDATE",
            before: json(mapProperty(before)),
            after: json(after),
            pendingActionId: audit.pendingActionId,
          },
        });
        return after;
      },
    },
    pendingActions: {
      async create(action) {
        const created = await db.pendingAction.create({
          data: {
            userId: action.userId,
            conversationId: action.conversationId,
            type: action.type,
            propertyId: action.propertyId,
            payload: json(action.payload),
            diff: json(action.diff),
            expectedVersion: action.expectedVersion,
            createdInRunId: action.createdInRunId,
            expiresAt: action.expiresAt,
          },
        });
        return mapPending(created);
      },
      async get(userId, conversationId, id) {
        const a = await db.pendingAction.findFirst({ where: { id, userId, conversationId } });
        return a ? mapPending(a) : null;
      },
      async listPending(userId, conversationId) {
        const rows = await db.pendingAction.findMany({
          where: { userId, conversationId, status: "PENDING" },
          orderBy: { createdAt: "asc" },
        });
        return rows.map(mapPending);
      },
      async resolve(id, to, at) {
        const { count } = await db.pendingAction.updateMany({
          where: { id, status: "PENDING" },
          data: { status: to, resolvedAt: at },
        });
        return count === 1;
      },
    },
    async transaction(fn) {
      if (!root) return fn(stores); // already inside a transaction
      return root.$transaction((tx) => fn(storesFor(tx, null)));
    },
  };
  return stores;
}

export function createPrismaStores(prisma: PrismaClient): Stores {
  return storesFor(prisma, prisma);
}
