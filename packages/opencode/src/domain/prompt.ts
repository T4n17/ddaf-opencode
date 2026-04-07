import { Effect, Layer, ServiceMap } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { Config } from "../config/config"
import { Domain } from "."
import { Classifier } from "./classifier"
import { Memory } from "../memory"
import { Skill } from "../skill"
import { Log } from "../util/log"
import type { Agent } from "../agent/agent"
import { Auth } from "../auth"
import { Provider } from "../provider/provider"
import { Bus } from "@/bus"
import { AppFileSystem } from "@/filesystem"

export namespace DomainPrompt {
  const log = Log.create({ service: "domain.prompt" })

  export interface Resolved {
    domain: Domain.Info
    system: string[]
    tools: string[] | undefined
    mcps: string[] | undefined
    skills: string[]
    memory: string
  }

  export interface Interface {
    readonly resolve: (input: {
      query: string
      agent: Agent.Info
    }) => Effect.Effect<Resolved>
    readonly memorize: (text: string) => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/DomainPrompt") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const domain = yield* Domain.Service
      const classifier = yield* Classifier.Service
      const memory = yield* Memory.Service
      const skill = yield* Skill.Service

      const resolve = Effect.fn("DomainPrompt.resolve")(function* (input: {
        query: string
        agent: Agent.Info
      }) {
        const cfg = yield* config.get()
        const domains = yield* domain.all()

        // skip classification if no domains defined
        if (domains.length <= 1) {
          return {
            domain: yield* domain.fallback(),
            system: [],
            tools: undefined,
            mcps: undefined,
            skills: [],
            memory: "",
          } satisfies Resolved
        }

        // classify the query
        const matched = yield* classifier.classify(input.query)
        log.info("resolved domain", { domain: matched.name, query: input.query.slice(0, 80) })

        // build domain-specific system prompt
        const system: string[] = []
        if (matched.prompt) {
          system.push(`<domain name="${matched.name}">\n${matched.prompt}\n</domain>`)
        }

        // retrieve conversation summary
        const enabled = cfg.memory?.enabled !== false
        const summary = enabled ? yield* memory.get() : ""

        if (summary) {
          system.push(`<memory>\n${summary}\n</memory>`)
        }

        // filter skills by domain
        const available = yield* skill.available(input.agent)
        const scoped = matched.skills
          ? available.filter((s) => matched.skills!.includes(s.name))
          : available

        // format skills (RAG-style: only relevant ones)
        if (scoped.length > 0) {
          const formatted = scoped
            .map((s) => `- **${s.name}**: ${s.description}`)
            .join("\n")
          system.push(
            `Skills available for this domain:\n${formatted}\nUse the skill tool to load a skill when needed.`,
          )
        }

        return {
          domain: matched,
          system,
          tools: matched.tools,
          mcps: matched.mcps,
          skills: scoped.map((s) => s.name),
          memory: summary,
        } satisfies Resolved
      })

      const memorize = Effect.fn("DomainPrompt.memorize")(function* (text: string) {
        const cfg = yield* config.get()
        if (cfg.memory?.enabled === false) return
        yield* memory.add(text)
        yield* memory.flush()
      })

      return Service.of({ resolve, memorize })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(Domain.defaultLayer),
    Layer.provide(Classifier.defaultLayer),
    Layer.provide(Memory.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(AppFileSystem.defaultLayer),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function resolve(input: { query: string; agent: Agent.Info }) {
    return runPromise((svc) => svc.resolve(input))
  }

  export async function memorize(text: string) {
    return runPromise((svc) => svc.memorize(text))
  }
}
