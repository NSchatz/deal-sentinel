/**
 * The delivery channel: the one place this system SENDS rather than asks, and
 * the reasons it is still not allowed a client of its own.
 *
 * IT TAKES A `Governor` AND NOTHING THAT CAN SEND. A notification leaves
 * through `Governor.request` like every other byte: behind the configured host
 * ceiling, the randomised delay, the robots decision, the back-pressure hold,
 * the breaker and the allowance. The consequence worth stating plainly is the
 * one the repository card names - the household's residential IP is on the line
 * again the moment this system sends anything, and a delivery loop against a
 * notification host is the same runaway client a scrape loop is. A host with no
 * ceiling in `config/governor.json` is REFUSED by the governor's first gate,
 * and this module has no way to talk it round.
 *
 * FOUR RULES ABOUT FAILURE, and each one is a decision about what an owner is
 * left with:
 *
 *   1. NO REDELIVERY INSIDE A RUN. A channel that just failed is not helped by
 *      being asked again a millisecond later, and a retry loop against a server
 *      that is down is how one alert becomes a thousand requests. The next run
 *      tries again - and it will, because a failed delivery records no
 *      cooldown.
 *   2. NO COOLDOWN ON A FAILURE. The cooldown exists to suppress a SENT alert.
 *      Recording one for a notification that never arrived would suppress the
 *      alert the owner never got, which is the worst of both directions. This
 *      module reports the failure and the run writes nothing.
 *   3. AN AUTHENTICATION OR AUTHORIZATION REFUSAL STOPS THE CHANNEL FOR THE
 *      RUN. A 401 or a 403 is a statement about the credential, not about this
 *      notification, so every further attempt in the run would fail the same
 *      way and spend the same allowance to learn the same fact. The rest of the
 *      run still EVALUATES; it just delivers nothing more.
 *   4. THE REMAINING NOTIFICATIONS ARE STILL ATTEMPTED after an ordinary
 *      failure. One listing's delivery failing says nothing about the next.
 *
 * AND TWO RULES ABOUT SECRETS. The credential is read once, put in a header, and
 * never anywhere else: not in the body, not in a report, not in a stored row.
 * Every string this module hands back has been through the redactor, because
 * the governor quotes the request URL inside its own refusal details and the
 * endpoint may be a credential in itself. And a credential written into the
 * ENDPOINT'S USERINFO - `https://user:password@host/topic` - is not sent at all:
 * a credential belongs in a header, where this module can keep it out of every
 * string it reports, and a credential inside the URL is one the governor, the
 * transport and every error either of them raises would quote back verbatim.
 * The redactor catches those quotes; refusing to send is what stops them being
 * made. A credential-bearing QUERY parameter is a different matter and is
 * accepted, because a webhook URL is a bearer credential wearing a URL's clothes
 * and refusing one would refuse the channels this system exists to reach.
 */

import type { Governor } from "@deal-sentinel/governor";

import type { AlertChannelConfig } from "./config.ts";
import { MissingChannelCredentialError } from "./errors.ts";
import type { AlertNotification } from "./notification.ts";
import { channelOrigin, channelRedactor } from "./redaction.ts";
import type { Redactor } from "./redaction.ts";

export type DeliveryOutcome =
  | { delivered: true; status: number }
  | {
      delivered: false;
      /**
       * `unconfigured` - no usable endpoint is configured, so nothing was
       *                  attempted: none at all, or one carrying a credential
       *                  in its userinfo, which this module will not send;
       * `refused`      - the channel rejected the credential (rule 3);
       * `failed`       - anything else: a governor refusal, a transport error,
       *                  a timeout, an error status.
       */
      kind: "unconfigured" | "refused" | "failed";
      /** Names the channel by origin. Redacted; safe to print and to store. */
      detail: string;
      /**
       * True when nothing further may be delivered in this run. Set for an
       * authentication or authorization refusal, and for nothing else.
       */
      stopChannel: boolean;
    };

/** What a run delivers through. One implementation sends; the rest are tests. */
export type AlertChannel = {
  /** How this channel is named in a report. Never the whole endpoint. */
  readonly describedAs: string;
  deliver(notification: AlertNotification): Promise<DeliveryOutcome>;
};

/**
 * The statuses that mean "your credential is the problem".
 *
 * 401 is the standard's own answer to a missing or bad credential. 403 is
 * included because a notification server that requires a token for a topic
 * answers a wrong one with either, and both say the same thing about what the
 * rest of this run would achieve.
 */
const CREDENTIAL_REFUSAL_STATUSES = new Set([401, 403]);

export type GovernedChannelDependencies = {
  governor: Governor;
  config: AlertChannelConfig;
  /** The source id the governor knows this channel by. Its second gate. */
  sourceId: string;
  /** The environment the credential is read from. Never the value itself. */
  env?: NodeJS.ProcessEnv;
};

/**
 * The delivery channel, built.
 *
 * Refuses to exist without the configured credential, exactly as the source
 * adapters do: a publish with no credential to a channel that wants one is
 * answered with a refusal, and spending a request to learn what the
 * environment already knows helps nobody.
 */
export function createGovernedChannel(
  dependencies: GovernedChannelDependencies,
): AlertChannel {
  const { governor, config, sourceId } = dependencies;
  const env = dependencies.env ?? process.env;

  let secret: string | null = null;
  if (config.credential !== null && config.endpoint !== null) {
    const value = env[config.credential.variable];
    if (value === undefined || value.trim().length === 0) {
      throw new MissingChannelCredentialError(config.credential.variable);
    }
    secret = value.trim();
  }

  return governedChannel({ governor, config, sourceId, credential: secret });
}

export type GovernedChannelParts = {
  governor: Governor;
  config: AlertChannelConfig;
  sourceId: string;
  /** The credential, already read, or null where the channel needs none. */
  credential: string | null;
};

export function governedChannel(parts: GovernedChannelParts): AlertChannel {
  const { governor, config, sourceId, credential } = parts;
  const redactor: Redactor = channelRedactor(credential);
  const describedAs =
    config.endpoint === null ? "no channel configured" : channelOrigin(config.endpoint);
  // Decided once: the endpoint does not change between notifications, and a
  // refusal that costs a governor request to discover is a refusal that spends
  // the household's allowance on a configuration error.
  const endpointCarriesUserinfo =
    config.endpoint !== null && carriesUserinfo(config.endpoint);

  return {
    describedAs,

    async deliver(notification): Promise<DeliveryOutcome> {
      if (endpointCarriesUserinfo) {
        // Nothing is attempted, so nothing leaves, nothing is suppressed, and
        // no string carrying the credential is composed by anyone. The endpoint
        // is NOT quoted here: naming the channel by origin is the whole point.
        return {
          delivered: false,
          kind: "unconfigured",
          detail:
            `${describedAs} was not asked for ${notification.ruleId} on ` +
            `${notification.sourceId}/${notification.listingId}: ` +
            "channel.endpoint in config/alerts.json carries a credential in " +
            "its userinfo, the user:password@ before the host, and a " +
            "credential inside a URL is quoted back by every error that URL " +
            "appears in. Move it to channel.credential, which puts it in a " +
            "header and keeps it out of every reported string.",
          stopChannel: false,
        };
      }

      if (config.endpoint === null) {
        // The fail-closed default this repository ships. Nothing is attempted,
        // so nothing leaves and nothing is suppressed by a cooldown either.
        return {
          delivered: false,
          kind: "unconfigured",
          detail:
            "no channel endpoint is configured in config/alerts.json, so " +
            `${notification.ruleId} fired for ${notification.sourceId}/` +
            `${notification.listingId} and nothing was delivered. Configure ` +
            "channel.endpoint, and add that host's ceiling to " +
            "config/governor.json, to start receiving alerts.",
          stopChannel: false,
        };
      }

      const headers: Record<string, string> = { ...config.headers };
      headers["content-type"] = "text/plain; charset=utf-8";
      if (config.titleHeader !== null) headers[config.titleHeader] = notification.title;
      if (config.linkHeader !== null) headers[config.linkHeader] = notification.listingUrl;
      if (config.credential !== null && credential !== null) {
        headers[config.credential.header] = `${config.credential.prefix}${credential}`;
      }

      const outcome = await governor.request({
        url: config.endpoint,
        sourceId,
        method: config.method,
        headers,
        // The alert itself. The credential is in a header and is not here.
        body: notification.body,
      });

      if (!outcome.ok) {
        // Every governor refusal lands here, `unconfigured-host` included -
        // which is what a notification host with no ceiling gets, and it is a
        // failure rather than a stop because the next run may find the ceiling
        // configured. Scrubbed: the governor quotes the URL it was given.
        return {
          delivered: false,
          kind: "failed",
          detail: redactor.scrub(
            `${describedAs} was not reached for ${notification.ruleId} on ` +
              `${notification.sourceId}/${notification.listingId}: ` +
              `${outcome.reason} - ${outcome.detail}`,
          ),
          stopChannel: false,
        };
      }

      const status = outcome.response.status;

      if (CREDENTIAL_REFUSAL_STATUSES.has(status)) {
        return {
          delivered: false,
          kind: "refused",
          detail: redactor.scrub(
            `${describedAs} answered ${status} for ${notification.ruleId} on ` +
              `${notification.sourceId}/${notification.listingId}, which is a ` +
              "refusal of the credential rather than of this notification. No " +
              "further delivery is attempted for the rest of this run, and no " +
              "cooldown is recorded for anything that was not delivered.",
          ),
          stopChannel: true,
        };
      }

      if (status < 200 || status > 299) {
        return {
          delivered: false,
          kind: "failed",
          detail: redactor.scrub(
            `${describedAs} answered ${status} for ${notification.ruleId} on ` +
              `${notification.sourceId}/${notification.listingId}. It is not ` +
              "retried inside this run and no cooldown is recorded, so the " +
              "next run attempts it again.",
          ),
          stopChannel: false,
        };
      }

      return { delivered: true, status };
    },
  };
}

/**
 * Does this endpoint keep a credential in its userinfo component?
 *
 * Asked on the PARSED URL rather than through the redactor, and deliberately:
 * the redactor's URL rules also cover a credential-bearing query parameter, and
 * an endpoint carrying one of those is a webhook URL, which this system accepts
 * and never prints. Userinfo is the case that is refused, so it is the case this
 * predicate names.
 */
function carriesUserinfo(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    // Unreachable through the loader, which refuses an endpoint that does not
    // parse. A string that is not a URL carries no userinfo either.
    return false;
  }
}
