import { Effect, Layer, ServiceMap } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { Provider } from "../provider/provider"
import { Config } from "../config/config"
import { Auth } from "../auth"
import { Domain } from "."
import { Log } from "../util/log"
import { generateText, type ModelMessage } from "ai"

export namespace Classifier {
  const log = Log.create({ service: "domain.classifier" })

  export interface Interface {
    readonly classify: (query: string) => Effect.Effect<Domain.Info>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Classifier") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const domain = yield* Domain.Service
      const provider = yield* Provider.Service

      const classify = Effect.fn("Classifier.classify")(function* (query: string) {
        const domains = yield* domain.all()

        // if only fallback exists, skip classification
        if (domains.length <= 1) return yield* domain.fallback()

        const names = yield* domain.names()
        const catalog = domains
          .map((d) => `- ${d.name}: ${d.description}`)
          .join("\n")

        const model = yield* provider.defaultModel()
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const lang = yield* provider.getLanguage(resolved)

        const result = yield* Effect.tryPromise({
          try: () =>
            generateText({
              model: lang,
              temperature: 0,
              maxOutputTokens: 20,
              messages: [
                {
                  role: "system",
                  content: `Classify the user query into exactly one domain. Reply with ONLY the domain name, nothing else.\n\nDomains:\n${catalog}`,
                } satisfies ModelMessage,
                {
                  role: "user",
                  content: query,
                } satisfies ModelMessage,
              ],
            }).then((r) => r.text.trim().toLowerCase()),
          catch: (err) => err,
        }).pipe(
          Effect.catch(
            Effect.fnUntraced(function* (err) {
              log.error("classification failed, using fallback", { err })
              return Domain.FALLBACK.name
            }),
          ),
        )

        // extract the domain name from response (pick first known name found)
        const matched = names.find((n) => result.includes(n))
        const name = matched ?? Domain.FALLBACK.name
        log.info("classified", { query: query.slice(0, 80), result, name })

        const info = yield* domain.get(name)
        return info ?? (yield* domain.fallback())
      })

      return Service.of({ classify })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(Domain.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function classify(query: string) {
    return runPromise((svc) => svc.classify(query))
  }
}
