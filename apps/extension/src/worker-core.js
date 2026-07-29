import {
  BRIDGE_URL,
  GUIDED_CAPABILITIES,
  SCHEMA_VERSION,
} from "./constants.js";
import { sha256Base64Url } from "./crypto.js";
import { fail } from "./errors.js";
import {
  assertExternalSender,
  assertFreshRequest,
  assertInternalSender,
  errorResponse,
  helloData,
  successResponse,
  validateExternalMessage,
  validateInternalMessage,
} from "./protocol.js";
import {
  buildNavigationTarget,
  inspectProviderTab,
  parseProviderResource,
  providerAndAction,
} from "./url-policy.js";

function bridgeUrl(fragmentValues) {
  const url = new URL(BRIDGE_URL);
  url.hash = new URLSearchParams(fragmentValues).toString();
  return url.href;
}

function summarizeResource(resource) {
  if (!resource) return null;
  return {
    provider: resource.provider,
    resourceKind: resource.resourceKind,
    providerEntityId: resource.providerEntityId,
    ...(resource.videoId ? { videoId: resource.videoId } : {}),
    ...(resource.playlistId ? { playlistId: resource.playlistId } : {}),
    redactedDisplayUrl: resource.redactedDisplayUrl,
    containsSecret: resource.containsSecret,
  };
}

export class GuidedWorkerCore {
  #repository;
  #tabs;
  #runtimeId;
  #extensionVersion;
  #now;

  constructor({ repository, tabs, runtimeId, extensionVersion, now = () => Date.now() }) {
    this.#repository = repository;
    this.#tabs = tabs;
    this.#runtimeId = runtimeId;
    this.#extensionVersion = extensionVersion;
    this.#now = now;
  }

  async #activeTab() {
    const tabs = await this.#tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs?.[0];
    if (!tab || typeof tab.id !== "number") fail("NO_ACTIVE_TAB");
    if (typeof tab.url !== "string") fail("ACTIVE_TAB_PERMISSION_REQUIRED");
    return { id: tab.id, url: tab.url };
  }

  async handleExternal(rawMessage, sender) {
    const nowMs = this.#now();
    const requestId = rawMessage?.requestId;
    try {
      assertExternalSender(sender);
      const message = validateExternalMessage(rawMessage);
      assertFreshRequest(message.issuedAtMs, nowMs);

      if (message.type === "EXT_HELLO") {
        return successResponse(message.requestId, helloData(this.#extensionVersion), nowMs);
      }

      if (message.type === "PAIR_CLAIM") {
        const session = await this.#repository.claimPairingInvite(
          message.body.pairingId,
          message.body.claimSecret,
          nowMs,
        );
        return successResponse(
          message.requestId,
          {
            ...session,
            extensionId: this.#runtimeId,
            capabilities: GUIDED_CAPABILITIES,
          },
          nowMs,
        );
      }

      const authenticated = await this.#repository.acceptAuthenticatedRequest(
        message.auth,
        message.requestId,
        nowMs,
      );

      if (message.type === "HANDOFF_CLAIM") {
        const payload = await this.#repository.claimHandoff(
          message.body.handoffId,
          authenticated.sessionId,
          nowMs,
        );
        return successResponse(message.requestId, { handoff: payload }, nowMs);
      }

      if (message.type === "NAVIGATION_STAGE") {
        const url = buildNavigationTarget(message.body.target);
        const summary = providerAndAction(message.body.target);
        let containsSecret = false;
        let redactedDisplayUrl = url;
        if (summary.provider === "soundcloud" && summary.action === "permalink") {
          const parsed = parseProviderResource(url);
          containsSecret = parsed.containsSecret;
          redactedDisplayUrl = parsed.redactedDisplayUrl;
        }
        const intent = await this.#repository.stageNavigation(
          {
            ...summary,
            url,
            containsSecret,
            redactedDisplayUrl,
            purpose: message.body.purpose,
            ...(message.body.correlationId
              ? { correlationId: message.body.correlationId }
              : {}),
          },
          authenticated.sessionId,
          nowMs,
        );
        return successResponse(
          message.requestId,
          { ...intent, requiresPopupConfirmation: true },
          nowMs,
        );
      }

      if (message.type === "SESSION_CLOSE") {
        await this.#repository.closeSession(authenticated.sessionId, nowMs);
        return successResponse(message.requestId, { closed: true }, nowMs);
      }

      if (message.type === "SESSION_CLEAR") {
        await this.#repository.clear();
        return successResponse(message.requestId, { cleared: true }, nowMs);
      }

      fail("UNKNOWN_MESSAGE_TYPE");
    } catch (error) {
      return errorResponse(requestId, error, nowMs);
    }
  }

  async handleInternal(rawMessage, sender) {
    const nowMs = this.#now();
    const requestId = rawMessage?.requestId;
    try {
      assertInternalSender(sender, this.#runtimeId);
      const message = validateInternalMessage(rawMessage);
      assertFreshRequest(message.issuedAtMs, nowMs);

      if (message.type === "POPUP_CONTEXT_GET") {
        const status = await this.#repository.status(nowMs);
        const tab = await this.#activeTab();
        let inspected;
        try {
          inspected = inspectProviderTab(tab.url);
        } catch {
          return successResponse(
            message.requestId,
            { status, recognized: false, capabilities: GUIDED_CAPABILITIES },
            nowMs,
          );
        }
        const urlFingerprint = await sha256Base64Url(tab.url);
        const context = await this.#repository.createPopupContext(
          { tabId: tab.id, urlFingerprint },
          nowMs,
        );
        return successResponse(
          message.requestId,
          {
            status,
            recognized: true,
            provider: inspected.provider,
            officialOrigin: inspected.officialOrigin,
            serviceTabEligible: Boolean(inspected.serviceTabUrl),
            resource: summarizeResource(inspected.resource),
            contextId: context.contextId,
            contextExpiresAtMs: context.expiresAtMs,
            capabilities: GUIDED_CAPABILITIES,
          },
          nowMs,
        );
      }

      if (message.type === "PAIR_INVITE_CREATE") {
        const invite = await this.#repository.createPairingInvite(nowMs);
        const url = bridgeUrl({
          mode: "pair",
          extensionId: this.#runtimeId,
          pairingId: invite.pairingId,
          claimSecret: invite.claimSecret,
        });
        await this.#tabs.create({ url, active: true });
        return successResponse(
          message.requestId,
          { pairingId: invite.pairingId, expiresAtMs: invite.expiresAtMs, opened: true },
          nowMs,
        );
      }

      if (message.type === "CAPTURE_PROVIDER_URL") {
        const tab = await this.#activeTab();
        const urlFingerprint = await sha256Base64Url(tab.url);
        await this.#repository.consumePopupContext(
          message.body.contextId,
          tab.id,
          urlFingerprint,
          nowMs,
        );
        const inspected = inspectProviderTab(tab.url);
        let capture;
        if (message.body.mode === "resource") {
          if (!inspected.resource) fail("UNSUPPORTED_RESOURCE");
          capture = inspected.resource;
        } else {
          if (!inspected.serviceTabUrl) fail("UNSUPPORTED_PROFILE_TAB");
          capture = {
            provider: inspected.provider,
            resourceKind: "service-tab",
            canonicalUrl: inspected.serviceTabUrl,
            redactedDisplayUrl: inspected.serviceTabUrl,
            containsSecret: false,
          };
        }
        const payload = {
          schemaVersion: SCHEMA_VERSION,
          provider: capture.provider,
          resourceKind: capture.resourceKind,
          ...(capture.providerEntityId
            ? { providerEntityId: capture.providerEntityId }
            : {}),
          ...(capture.videoId ? { videoId: capture.videoId } : {}),
          ...(capture.playlistId ? { playlistId: capture.playlistId } : {}),
          canonicalUrl: capture.canonicalUrl,
          redactedDisplayUrl: capture.redactedDisplayUrl,
          containsSecret: capture.containsSecret,
          capturedAtMs: nowMs,
          evidence: {
            method: "USER_GESTURE_ACTIVE_TAB_URL",
            officialOriginConfirmed: true,
            idSyntaxConfirmed: Boolean(capture.providerEntityId),
            domRead: false,
            providerReadBack: false,
            ownerVerified: false,
            writeAccessVerified: false,
          },
        };
        const handoff = await this.#repository.createHandoff(payload, nowMs);
        return successResponse(
          message.requestId,
          {
            ...handoff,
            provider: capture.provider,
            resourceKind: capture.resourceKind,
            redactedDisplayUrl: capture.redactedDisplayUrl,
          },
          nowMs,
        );
      }

      if (message.type === "HANDOFF_OPEN_LOCAL_APP") {
        const handoff = await this.#repository.getHandoffOpenInfo(
          message.body.handoffId,
          nowMs,
        );
        const url = bridgeUrl({
          mode: "handoff",
          extensionId: this.#runtimeId,
          handoffId: handoff.handoffId,
          sessionId: handoff.sessionId,
        });
        await this.#tabs.create({ url, active: true });
        return successResponse(message.requestId, { opened: true }, nowMs);
      }

      if (message.type === "NAVIGATION_LIST") {
        const intents = await this.#repository.listNavigationIntents(nowMs);
        return successResponse(message.requestId, { intents }, nowMs);
      }

      if (message.type === "NAVIGATION_OPEN") {
        const navigation = await this.#repository.consumeNavigationIntent(
          message.body.navigationId,
          nowMs,
        );
        await this.#tabs.create({ url: navigation.url, active: true });
        return successResponse(
          message.requestId,
          { opened: true, provider: navigation.provider, action: navigation.action },
          nowMs,
        );
      }

      if (message.type === "SESSION_CLEAR") {
        await this.#repository.clear();
        return successResponse(message.requestId, { cleared: true }, nowMs);
      }

      fail("UNKNOWN_MESSAGE_TYPE");
    } catch (error) {
      return errorResponse(requestId, error, nowMs);
    }
  }
}
