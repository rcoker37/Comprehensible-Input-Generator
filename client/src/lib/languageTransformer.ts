// Generic deinflection engine. Re-implementation of Yomitan's algorithm
// (https://github.com/yomidevs/yomitan/blob/master/ext/js/language/language-transformer.js)
// written from the algorithm description rather than copied source — Yomitan
// is GPL-3.0 and we want this engine MIT to match the rest of the project.
// The Japanese rule data lives in `japaneseTransforms.ts` and is GPL-3.0.

export type RuleType = "suffix" | "prefix" | "wholeWord" | "other";

export interface RuleI18n {
  language: string;
  name: string;
  description?: string;
}

export interface Condition {
  name: string;
  isDictionaryForm: boolean;
  subConditions?: string[];
  i18n?: RuleI18n[];
}

export interface Rule<TCondition extends string = string> {
  type: RuleType;
  isInflected: RegExp;
  deinflect: (text: string) => string;
  conditionsIn: TCondition[];
  conditionsOut: TCondition[];
}

export interface Transform<TCondition extends string = string> {
  name: string;
  description?: string;
  rules: Rule<TCondition>[];
  i18n?: RuleI18n[];
}

export interface LanguageTransformDescriptor<TCondition extends string = string> {
  language: string;
  conditions: Record<TCondition, Condition>;
  transforms: Record<string, Transform<TCondition>>;
}

export interface TraceFrame {
  transform: string;
  ruleIndex: number;
  text: string;
}

export type Trace = TraceFrame[];

export interface TransformedText {
  text: string;
  conditions: number;
  trace: Trace;
}

interface CompiledRule {
  type: RuleType;
  isInflected: RegExp;
  deinflect: (text: string) => string;
  conditionsIn: number;
  conditionsOut: number;
}

interface CompiledTransform {
  id: string;
  name: string;
  description?: string;
  rules: CompiledRule[];
  heuristic: RegExp;
}

const MAX_FLAGS = 32;

export function suffixInflection<TCondition extends string>(
  inflectedSuffix: string,
  deinflectedSuffix: string,
  conditionsIn: TCondition[],
  conditionsOut: TCondition[]
): Rule<TCondition> {
  const isInflected = new RegExp(inflectedSuffix + "$");
  return {
    type: "suffix",
    isInflected,
    deinflect: (text) =>
      text.slice(0, text.length - inflectedSuffix.length) + deinflectedSuffix,
    conditionsIn,
    conditionsOut,
  };
}

export function prefixInflection<TCondition extends string>(
  inflectedPrefix: string,
  deinflectedPrefix: string,
  conditionsIn: TCondition[],
  conditionsOut: TCondition[]
): Rule<TCondition> {
  const isInflected = new RegExp("^" + inflectedPrefix);
  return {
    type: "prefix",
    isInflected,
    deinflect: (text) =>
      deinflectedPrefix + text.slice(inflectedPrefix.length),
    conditionsIn,
    conditionsOut,
  };
}

export function wholeWordInflection<TCondition extends string>(
  inflectedWord: string,
  deinflectedWord: string,
  conditionsIn: TCondition[],
  conditionsOut: TCondition[]
): Rule<TCondition> {
  const isInflected = new RegExp("^" + inflectedWord + "$");
  return {
    type: "wholeWord",
    isInflected,
    deinflect: () => deinflectedWord,
    conditionsIn,
    conditionsOut,
  };
}

export class LanguageTransformer {
  private nextFlagIndex = 0;
  private transforms: CompiledTransform[] = [];
  private conditionFlags = new Map<string, number>();

  addDescriptor(descriptor: LanguageTransformDescriptor): void {
    const { conditions, transforms } = descriptor;
    const localFlags = this.compileConditions(conditions);

    for (const [id, transform] of Object.entries(transforms)) {
      const compiledRules: CompiledRule[] = transform.rules.map((rule, idx) => {
        const inFlags = orFlags(localFlags, rule.conditionsIn);
        const outFlags = orFlags(localFlags, rule.conditionsOut);
        if (inFlags === null) {
          throw new Error(
            `Unknown condition in transforms.${id}.rules[${idx}].conditionsIn: ${rule.conditionsIn.join(", ")}`
          );
        }
        if (outFlags === null) {
          throw new Error(
            `Unknown condition in transforms.${id}.rules[${idx}].conditionsOut: ${rule.conditionsOut.join(", ")}`
          );
        }
        return {
          type: rule.type,
          isInflected: rule.isInflected,
          deinflect: rule.deinflect,
          conditionsIn: inFlags,
          conditionsOut: outFlags,
        };
      });
      const heuristic = new RegExp(
        transform.rules.map((r) => r.isInflected.source).join("|")
      );
      this.transforms.push({
        id,
        name: transform.name,
        description: transform.description,
        rules: compiledRules,
        heuristic,
      });
    }
  }

  /**
   * Run BFS over the rule set. Each result carries its own trace; cycles are
   * broken by checking whether the same (transform, ruleIndex, text) tuple
   * already appears upstream in the trace.
   */
  transform(sourceText: string): TransformedText[] {
    const results: TransformedText[] = [
      { text: sourceText, conditions: 0, trace: [] },
    ];

    for (let i = 0; i < results.length; i++) {
      const { text, conditions, trace } = results[i];
      for (const transform of this.transforms) {
        if (!transform.heuristic.test(text)) continue;

        for (let j = 0; j < transform.rules.length; j++) {
          const rule = transform.rules[j];
          if (!conditionsMatch(conditions, rule.conditionsIn)) continue;
          if (!rule.isInflected.test(text)) continue;

          const isCycle = trace.some(
            (frame) =>
              frame.transform === transform.id &&
              frame.ruleIndex === j &&
              frame.text === text
          );
          if (isCycle) continue;

          const nextText = rule.deinflect(text);
          const nextTrace: Trace = [
            { transform: transform.id, ruleIndex: j, text },
            ...trace,
          ];
          results.push({
            text: nextText,
            conditions: rule.conditionsOut,
            trace: nextTrace,
          });
        }
      }
    }

    return results;
  }

  /** Resolves a condition name to its bitmask. Returns 0 for unknown names. */
  getConditionFlag(name: string): number {
    return this.conditionFlags.get(name) ?? 0;
  }

  private compileConditions(
    conditions: Record<string, Condition>
  ): Map<string, number> {
    const localFlags = new Map<string, number>();
    let pending = Object.entries(conditions);

    while (pending.length > 0) {
      const next: typeof pending = [];
      for (const entry of pending) {
        const [name, condition] = entry;
        if (condition.subConditions === undefined) {
          if (this.nextFlagIndex >= MAX_FLAGS) {
            throw new Error(
              "LanguageTransformer supports at most 32 leaf conditions"
            );
          }
          const flag = 1 << this.nextFlagIndex;
          this.nextFlagIndex++;
          localFlags.set(name, flag);
          this.conditionFlags.set(name, flag);
        } else {
          const resolved = orFlags(localFlags, condition.subConditions);
          if (resolved === null) {
            next.push(entry);
            continue;
          }
          localFlags.set(name, resolved);
          this.conditionFlags.set(name, resolved);
        }
      }
      if (next.length === pending.length) {
        const stuck = next.map(([n]) => n).join(", ");
        throw new Error(`Cycle or unknown subCondition in: ${stuck}`);
      }
      pending = next;
    }

    return localFlags;
  }
}

function conditionsMatch(current: number, required: number): boolean {
  return current === 0 || (current & required) !== 0;
}

function orFlags(
  map: Map<string, number>,
  names: string[]
): number | null {
  let flags = 0;
  for (const name of names) {
    const f = map.get(name);
    if (f === undefined) return null;
    flags |= f;
  }
  return flags;
}
