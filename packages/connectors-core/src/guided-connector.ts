import { randomUUID } from "node:crypto";
import { guidedCapabilities, isProviderOEmbedEnabled, providerLimitations } from "./policy";
import { buildSearchUrl, parseProviderUrl } from "./url-policy";
import { validateWithOfficialOEmbed } from "./oembed";
import type { GuidedAction, Provider, ProviderConnector, ProviderEntityRef, ValidationResult } from "./types";

export class GuidedConnector implements ProviderConnector {
  readonly strategy = "guided" as const;
  readonly capabilities;

  constructor(readonly provider: Provider) {
    this.capabilities = guidedCapabilities[provider];
  }

  parseUserUrl(url: string): ProviderEntityRef {
    return parseProviderUrl(this.provider, url);
  }

  buildSearchUrl(query: string): string {
    return buildSearchUrl(this.provider, query);
  }

  async validateTargetEntity(ref: ProviderEntityRef): Promise<ValidationResult> {
    if (ref.provider !== this.provider) throw new Error("PROVIDER_MISMATCH");
    if (!isProviderOEmbedEnabled()) {
      return {
        ref: { ...ref, validationStatus: "USER_SELECTED_UNVERIFIED" },
        evidence: {
          method: "URL_SYNTAX",
          checkedAt: Date.now(),
          providerReadBack: false,
          semanticEqualityProven: false,
        },
        limitations: [...providerLimitations[this.provider], "PROVIDER_OEMBED_POLICY_ACKNOWLEDGEMENT_REQUIRED"],
      };
    }
    try {
      return await validateWithOfficialOEmbed(ref);
    } catch {
      return {
        ref: { ...ref, validationStatus: "USER_SELECTED_UNVERIFIED" },
        evidence: {
          method: "URL_SYNTAX",
          checkedAt: Date.now(),
          providerReadBack: false,
          semanticEqualityProven: false,
        },
        limitations: [...providerLimitations[this.provider], "PROVIDER_READBACK_UNAVAILABLE"],
      };
    }
  }

  buildAddAction(
    ref: ProviderEntityRef,
    destination: { id?: string; url?: string; label: string },
  ): GuidedAction {
    if (ref.provider !== this.provider) throw new Error("PROVIDER_MISMATCH");
    const noun = this.provider === "youtube" ? "videoId" : this.provider === "spotify" ? "track ID" : "permalink";
    return {
      id: randomUUID(),
      provider: this.provider,
      kind: "ADD_ITEM",
      title: `Добавьте ${noun} в «${destination.label}»`,
      instructions: [
        "Откройте официальную страницу по кнопке ниже.",
        `В официальном интерфейсе выберите Add/Save и плейлист «${destination.label}».`,
        "Вернитесь в приложение и отдельно подтвердите: элемент присутствует или отсутствует.",
      ],
      openUrl: ref.redactedDisplayUrl,
      targetEntityId: ref.videoId ?? ref.providerEntityId ?? ref.redactedDisplayUrl,
      destinationLabel: destination.label,
      expectedManualActions: 3,
      automation: "USER_OPERATED",
    };
  }
}
