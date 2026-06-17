/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Analyzer } from '../core/analyzer';
import type { ParseResult } from '../core/parser';
import type { Session } from '../core/types';
import { getRule } from '../core/rule-engine';
import { serializeRule } from '../core/rule-parser';
import { DSL_CHEATSHEET } from '../webview/dsl-cheatsheet';
import { validateDateFilter } from '../webview/panel-rpc';
import { errorResult, isNumber, isOptionalString, isRecord, isString } from '../webview/panel-shared';
import { callLocalLlm, callLocalLlmJson, localLlmUnavailableMessage, type LocalLlmMessage } from './llm';

type LocalAiMethodName =
  | 'createSkill'
  | 'generateSkillContent'
  | 'generateLearningQuiz'
  | 'generateLearningResources'
  | 'generateCodeComparison'
  | 'generateDidYouKnow'
  | 'triageSkills'
  | 'triageCatalog'
  | 'reviewContextFiles'
  | 'generateRule'
  | 'explainOccurrence';

type QuizDifficulty = 'easy' | 'medium' | 'hard';

interface QuizQuestion {
  question: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  difficulty: string;
  topic: string;
}

interface AiHandlerContext {
  analyzer?: Analyzer;
  parseResult?: ParseResult;
  emitEvent?: (method: string, data: unknown) => void;
}

const AI_METHODS: ReadonlySet<string> = new Set<LocalAiMethodName>([
  'createSkill',
  'generateSkillContent',
  'generateLearningQuiz',
  'generateLearningResources',
  'generateCodeComparison',
  'generateDidYouKnow',
  'triageSkills',
  'triageCatalog',
  'reviewContextFiles',
  'generateRule',
  'explainOccurrence',
]);

const QUIZ_DIFFICULTIES: ReadonlySet<QuizDifficulty> = new Set(['easy', 'medium', 'hard']);

export function isLocalAiMethod(method: string): method is LocalAiMethodName {
  return AI_METHODS.has(method);
}

export async function handleLocalAiMethod(
  method: LocalAiMethodName,
  params: unknown,
  context: AiHandlerContext,
): Promise<unknown> {
  try {
    switch (method) {
      case 'createSkill':
        return { ok: true };
      case 'generateSkillContent':
        return await generateSkillContent(params);
      case 'generateLearningQuiz':
        return await generateLearningQuiz(params);
      case 'generateLearningResources':
        return await generateLearningResources(params);
      case 'generateCodeComparison':
        return await generateCodeComparison(params);
      case 'generateDidYouKnow':
        return await generateDidYouKnow(params);
      case 'triageSkills':
        return await triageSkills(params, context.parseResult);
      case 'triageCatalog':
        return await triageCatalog(params, context.parseResult);
      case 'reviewContextFiles':
        return await reviewContextFiles(params, context);
      case 'generateRule':
        return await generateRule(params);
      case 'explainOccurrence':
        return await explainOccurrence(params, context.analyzer);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'AI request failed';
    return errorResult(message);
  }
}

function getStringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.filter(isString).slice(0, limit) : [];
}

function toText(value: unknown): string {
  if (isString(value)) return value;
  if (isNumber(value) || typeof value === 'boolean') return String(value);
  return '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function responseItems(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  const items = asRecord(value).items;
  return Array.isArray(items) ? items.filter(isRecord) : [];
}

function stripMarkdownFence(content: string): string {
  let result = content.trim();
  if (result.startsWith('```')) {
    result = result.replace(/^```(?:markdown|md)?\n?/i, '').replace(/\n?```$/i, '');
  }
  return result.trim();
}

function slugify(value: string, fallback: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/-+/g, '-').replaceAll(/^-|-$/g, '') || fallback;
}

async function generateSkillContent(params: unknown): Promise<unknown> {
  const p = asRecord(params);
  const label = isString(p.label) ? p.label : 'skill';
  const pattern = isString(p.pattern) ? p.pattern : '';
  const occurrences = isNumber(p.occurrences) ? p.occurrences : 0;
  const sessions = isNumber(p.sessions) ? p.sessions : 0;
  const examples = getStringArray(p.examples, 5);
  const skillDraft = isString(p.skillDraft) ? p.skillDraft : '';

  const systemPrompt = `You are an expert at writing SKILL.md files for AI coding agents.
A skill file is a markdown instruction file that teaches an AI coding agent how to handle a repeated workflow pattern.

Generate a professional, production-ready SKILL.md file. Include:
1. YAML frontmatter with name, description, and an applyTo glob pattern
2. A clear "## When to Use" section
3. Detailed "## Steps" with numbered instructions the AI should follow
4. A "## Guidelines" section with quality criteria

Respond with only the markdown content of the SKILL.md file.`;

  const userPrompt = `Create a SKILL.md for this workflow pattern:

Name: ${label}
Pattern: ${pattern}
Seen ${occurrences} times across ${sessions} sessions.

Example prompts from the user:
${examples.map(example => `- "${example}"`).join('\n')}

Starting draft:
${skillDraft}`;

  const content = stripMarkdownFence(await callLocalLlm([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]));

  return { content, filename: `${slugify(label, 'skill')}/SKILL.md` };
}

function getQuizContext(params: unknown): {
  languages: string[];
  topics: string[];
  difficulty: QuizDifficulty;
  solved: number;
  failed: number;
  solvedSamples: string[];
  failedSamples: string[];
  focusSkills: string[];
  packageDeps: string[];
  customGoals: string[];
  leitnerBox: number;
  reviewTopics: string[];
} {
  const p = asRecord(params);
  const difficulty = isString(p.difficulty) && QUIZ_DIFFICULTIES.has(p.difficulty as QuizDifficulty)
    ? p.difficulty as QuizDifficulty
    : 'easy';
  return {
    languages: getStringArray(p.languages, 10),
    topics: getStringArray(p.topics, 10),
    difficulty,
    solved: isNumber(p.solved) ? p.solved : 0,
    failed: isNumber(p.failed) ? p.failed : 0,
    solvedSamples: getStringArray(p.solvedSamples, 5),
    failedSamples: getStringArray(p.failedSamples, 5),
    focusSkills: getStringArray(p.focusSkills, 10),
    packageDeps: getStringArray(p.packageDeps, 30),
    customGoals: getStringArray(p.customGoals, 5),
    leitnerBox: isNumber(p.leitnerBox) ? p.leitnerBox : 0,
    reviewTopics: getStringArray(p.reviewTopics, 10),
  };
}

async function generateLearningQuiz(params: unknown): Promise<unknown> {
  const context = getQuizContext(params);
  const reviewContext = context.leitnerBox > 0
    ? `\nSpaced repetition box: ${context.leitnerBox}/7. Current review topics: ${context.reviewTopics.join(', ') || 'general'}`
    : '';
  const systemPrompt = `You are a senior developer creating realistic coding challenges that test practical knowledge within a specific tech ecosystem.

Generate exactly 3 multiple-choice questions. Each question must have exactly 4 choices with exactly one correct answer.

Rules:
- Ask realistic coding scenario questions, not trivia.
- Include short code snippets when useful.
- Use the actual languages and dependencies as ecosystem context.
- Difficulty: ${context.difficulty}.
- Explanations should teach a practical insight in 1-2 sentences.
- The topic field should match one of the user's focus topics when possible.
${reviewContext}

Respond as JSON: {"items":[{"question":"...","choices":["A","B","C","D"],"correctIndex":0,"explanation":"...","difficulty":"easy|medium|hard","topic":"..."}]}`;

  const userPrompt = `Developer profile:
- Languages: ${context.languages.join(', ') || 'general programming'}
- Topics of interest: ${context.topics.join(', ') || 'general software engineering'}
- Stats: ${context.solved} solved, ${context.failed} failed
${context.packageDeps.length > 0 ? `- Key dependencies: ${context.packageDeps.slice(0, 15).join(', ')}` : ''}
${context.focusSkills.length > 0 ? `- Skill focus areas: ${context.focusSkills.join(', ')}` : ''}
${context.customGoals.length > 0 ? `- Custom goals: ${context.customGoals.join('; ')}` : ''}
${context.solvedSamples.length > 0 ? `- Avoid questions similar to: ${context.solvedSamples.join(' | ')}` : ''}
${context.failedSamples.length > 0 ? `- Reinforce topics from failed questions: ${context.failedSamples.join(' | ')}` : ''}`;

  const response = await callLocalLlmJson<{ items: QuizQuestion[] }>([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
  const questions = normalizeQuizQuestions(response, context.difficulty);
  return { questions };
}

function normalizeQuizQuestions(response: unknown, fallbackDifficulty: QuizDifficulty): Array<{
  question: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  difficulty: QuizDifficulty;
  topic: string;
}> {
  const questions = responseItems(response);
  return questions
    .filter(question => {
      const choices = getStringArray(question.choices, 4);
      return isString(question.question) &&
        choices.length === 4 &&
        isNumber(question.correctIndex) && question.correctIndex >= 0 && question.correctIndex < 4 &&
        isString(question.explanation);
    })
    .slice(0, 3)
    .map(question => ({
      question: toText(question.question),
      choices: getStringArray(question.choices, 4),
      correctIndex: isNumber(question.correctIndex) ? question.correctIndex : 0,
      explanation: toText(question.explanation),
      difficulty: QUIZ_DIFFICULTIES.has(question.difficulty as QuizDifficulty) ? question.difficulty as QuizDifficulty : fallbackDifficulty,
      topic: toText(question.topic) || 'general',
    }));
}

async function generateCodeComparison(params: unknown): Promise<unknown> {
  const p = asRecord(params);
  const languages = getStringArray(p.languages, 10);
  const packageDeps = getStringArray(p.packageDeps, 30);
  const difficulty = isString(p.difficulty) ? p.difficulty : 'medium';
  const seenTopics = getStringArray(p.seenTopics, 10);

  const systemPrompt = `You are a senior code reviewer generating side-by-side code comparisons for a code review training game.

Generate exactly 3 rounds. Each round presents two short code snippets that accomplish the same task. One snippet is subtly better than the other.

Rules:
- Both snippets must be plausible working code.
- Do not make the answer obvious with "bad" or "good" comments.
- Cover performance, safety, readability, correctness, or security.
- Use real patterns from: ${languages.join(', ') || 'general programming'}.
${packageDeps.length > 0 ? `- Use ecosystem context from dependencies: ${packageDeps.join(', ')}` : ''}
${seenTopics.length > 0 ? `- Avoid topics already seen: ${seenTopics.join(', ')}` : ''}

Respond as JSON: {"items":[{"snippetA":"code","snippetB":"code","betterSnippet":"A","title":"task","category":"performance|safety|readability|correctness|security","explanation":"why","difficulty":"easy|medium|hard","language":"language"}]}`;

  const response = await callLocalLlmJson<{ items?: Array<Record<string, unknown>> }>([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Difficulty: ${difficulty}. Generate rounds for this developer's ecosystem.` },
  ]);
  const rounds = responseItems(response);
  return {
    rounds: rounds
      .filter(round =>
        isString(round.snippetA) && isString(round.snippetB) &&
        (round.betterSnippet === 'A' || round.betterSnippet === 'B') &&
        isString(round.title) && isString(round.explanation),
      )
      .slice(0, 3)
      .map(round => ({
        snippetA: toText(round.snippetA),
        snippetB: toText(round.snippetB),
        betterSnippet: round.betterSnippet as 'A' | 'B',
        title: toText(round.title),
        category: ['performance', 'safety', 'readability', 'correctness', 'security'].includes(toText(round.category)) ? toText(round.category) : 'readability',
        explanation: toText(round.explanation),
        difficulty: ['easy', 'medium', 'hard'].includes(toText(round.difficulty)) ? toText(round.difficulty) : difficulty,
        language: toText(round.language) || languages[0] || 'code',
      })),
  };
}

async function generateDidYouKnow(params: unknown): Promise<unknown> {
  const p = asRecord(params);
  const languages = getStringArray(p.languages, 10);
  const packageDeps = getStringArray(p.packageDeps, 30);
  const workspaces = getStringArray(p.workspaces, 10);
  const seenFacts = getStringArray(p.seenFacts, 20);

  const systemPrompt = `You are a senior developer sharing practical "Did you know?" facts tailored to a developer's actual tech stack and projects.

Generate exactly 5 short, useful, specific facts. Facts must be actionable and reference a language, dependency, or project from the developer profile.

Languages: ${languages.join(', ') || 'general'}
Dependencies: ${packageDeps.join(', ') || 'none detected'}
Active projects: ${workspaces.join(', ') || 'none selected'}
${seenFacts.length > 0 ? `Avoid these already-shown facts: ${seenFacts.join(' | ')}` : ''}

Respond as JSON: {"items":[{"fact":"...", "project":"...", "category":"performance|api|pitfall|config|debug"}]}`;

  const response = await callLocalLlmJson<{ items?: Array<Record<string, unknown>> }>([
    { role: 'system', content: systemPrompt },
  ]);
  const facts = responseItems(response);
  return {
    facts: facts
      .filter(fact => isString(fact.fact) && isString(fact.project))
      .slice(0, 5)
      .map(fact => ({
        fact: toText(fact.fact),
        project: toText(fact.project),
        category: ['performance', 'api', 'pitfall', 'config', 'debug'].includes(toText(fact.category)) ? toText(fact.category) : 'api',
      })),
  };
}

async function generateLearningResources(params: unknown): Promise<unknown> {
  const p = asRecord(params);
  const languages = getStringArray(p.languages, 10);
  const gaps = getStringArray(p.gaps, 10);
  const focusConcepts = getStringArray(p.focusConcepts, 10);
  const packageDeps = getStringArray(p.packageDeps, 20);
  const workspaces = getStringArray(p.workspaces, 10);

  const systemPrompt = `You are a senior engineering mentor recommending learning resources for a developer.

Generate exactly 6 recommendations. Prefer official docs, reputable tutorials, practice platforms, and maintained repositories. Use only resources you are confident exist.

Developer profile:
- Languages: ${languages.join(', ') || 'general programming'}
- Key dependencies: ${packageDeps.join(', ') || 'none detected'}
- Knowledge gaps: ${gaps.join(', ') || 'none detected'}
- Focus concepts: ${focusConcepts.join(', ') || 'none selected'}
- Active projects: ${workspaces.join(', ') || 'none selected'}

Respond as JSON: {"items":[{"title":"...","url":"https://...","type":"Language|Framework|Concept|Practice","reason":"..."}]}`;

  const response = await callLocalLlmJson<{ items?: Array<Record<string, unknown>> }>([
    { role: 'system', content: systemPrompt },
  ]);
  const resources = responseItems(response);
  return {
    resources: resources
      .filter(resource => isString(resource.title) && isString(resource.url) && resource.url.startsWith('https://'))
      .slice(0, 6)
      .map(resource => ({
        title: toText(resource.title),
        url: toText(resource.url),
        type: toText(resource.type) || 'Resource',
        reason: toText(resource.reason),
      })),
  };
}

async function triageSkills(params: unknown, parseResult?: ParseResult): Promise<unknown> {
  const p = asRecord(params);
  const workspaceFilter = isString(p.workspace) ? p.workspace : undefined;
  const clustersRaw = Array.isArray(p.clusters) ? p.clusters : [];
  const clusterSummaries = clustersRaw.slice(0, 200).map(cluster => {
    const entry = asRecord(cluster);
    return {
      id: toText(entry.id),
      label: toText(entry.label),
      occurrences: isNumber(entry.occurrences) ? entry.occurrences : 0,
      sessions: isNumber(entry.sessions) ? entry.sessions : 0,
      cancelRate: isNumber(entry.cancelRate) ? entry.cancelRate : 0,
      avgCorrectionTurns: isNumber(entry.avgCorrectionTurns) ? entry.avgCorrectionTurns : 0,
      workspaces: Array.isArray(entry.workspaces) ? entry.workspaces : [],
      examples: getStringArray(entry.examples, 3),
    };
  });
  const context = getUserContext(parseResult);

  const systemPrompt = `You identify repeatable activities in a developer's AI coding assistant usage.

Given groups of similar prompts, return only groups that represent repeated workflow activities worth turning into a skill file. Skip generic coding questions, one-off debugging, standard refactors, and vague conversation.

Respond as JSON: {"items":[{"id":"cluster id","verdict":"strong","reason":"one sentence","suggestedSkillName":"short-kebab-name"}]}`;

  const userPrompt = `Developer context:
- Languages: ${context.languages.join(', ') || 'unknown'}
- Harnesses: ${context.harnesses.join(', ') || 'unknown'}
- Common topics: ${context.topics.join(', ') || 'unknown'}
- Workspaces: ${context.workspaces.join(', ') || 'unknown'}${workspaceFilter ? `\n- Currently filtering: ${workspaceFilter}` : ''}

Top repeated prompt groups:
${JSON.stringify(clusterSummaries, null, 2)}`;

  const response = await callLocalLlmJson<{ items?: Array<Record<string, unknown>> }>([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
  const triaged = responseItems(response);
  const validVerdicts = new Set(['strong', 'maybe', 'skip']);
  return {
    triaged: triaged.map(item => ({
      id: toText(item.id),
      label: clusterSummaries.find(cluster => cluster.id === item.id)?.label || '',
      verdict: validVerdicts.has(toText(item.verdict)) ? toText(item.verdict) : 'maybe',
      reason: toText(item.reason),
      suggestedSkillName: toText(item.suggestedSkillName) || null,
    })),
  };
}

async function triageCatalog(params: unknown, parseResult?: ParseResult): Promise<unknown> {
  const p = asRecord(params);
  const itemsRaw = Array.isArray(p.items) ? p.items.filter(isRecord) : [];
  const candidates = itemsRaw.map(item => {
    const entry = asRecord(item);
    return {
      id: toText(entry.id),
      kind: toText(entry.kind),
      title: toText(entry.title),
      description: toText(entry.description).slice(0, 120),
      category: toText(entry.category),
    };
  });
  const clustersRaw = Array.isArray(p.clusters) ? p.clusters : [];
  const clusterContext = clustersRaw.slice(0, 30).map(cluster => {
    const entry = asRecord(cluster);
    return {
      label: toText(entry.label),
      occurrences: isNumber(entry.occurrences) ? entry.occurrences : 0,
      workspaces: Array.isArray(entry.workspaces) ? entry.workspaces : [],
      examples: getStringArray(entry.examples, 2),
    };
  });
  const context = getUserContext(parseResult);
  const workspace = isOptionalString(p.workspace) ? p.workspace : undefined;

  const systemPrompt = `You recommend GitHub Copilot customization files for developers.

Given the developer context, repeated workflow patterns, and catalog candidates, pick catalog items that directly help the developer's actual repeated tasks or tech stack. Do not pad with generic picks.

Respond as JSON: {"items":[{"id":"candidate id","reason":"specific sentence referencing their workflow"}]}`;

  const userPrompt = `Developer context:
- Languages: ${context.languages.join(', ') || 'unknown'}
- Harnesses: ${context.harnesses.join(', ') || 'unknown'}
- Common topics: ${context.topics.join(', ') || 'unknown'}
- Analyzing workspace: ${workspace || 'all workspaces'}

Top repeated workflow patterns:
${JSON.stringify(clusterContext, null, 2)}

Catalog candidates:
${JSON.stringify(candidates)}`;

  const response = await callLocalLlmJson<{ items?: Array<Record<string, unknown>> }>([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
  const picks = responseItems(response);
  return {
    items: picks.map(pick => {
      const rawItem = itemsRaw.find(item => toText(item.id) === toText(pick.id));
      const raw = asRecord(rawItem);
      return {
        id: toText(pick.id),
        kind: toText(raw.kind),
        title: toText(raw.title),
        description: toText(raw.description),
        category: toText(raw.category),
        path: toText(raw.path),
        url: toText(raw.url),
        relevanceScore: 100,
        matchReasons: [toText(pick.reason)],
      };
    }).filter(item => item.title),
  };
}

async function reviewContextFiles(params: unknown, context: AiHandlerContext): Promise<unknown> {
  if (!context.analyzer) return errorResult('Analyzer not ready.');
  const p = asRecord(params);
  const maxCount = isNumber(p.count) ? Math.min(Math.max(1, p.count), 20) : 5;
  const workspaceIds = getStringArray(p.workspaceIds, maxCount);
  if (workspaceIds.length === 0) return errorResult('No workspaces specified.');

  const payloads = context.analyzer.getContextReviewPayload(workspaceIds);
  context.emitEvent?.('reviewProgress', {
    phase: 'start',
    workspaces: payloads.map(payload => ({ id: payload.workspaceId, name: payload.workspaceName })),
  });
  if (payloads.length === 0) return errorResult('Could not resolve workspace roots.');

  const categories = ['clarity', 'specificity', 'structure', 'completeness', 'staleness', 'redundancy', 'actionability'];
  const systemPrompt = `You evaluate AI coding assistant context files: instruction files, CLAUDE.md, copilot-instructions.md, prompt files, agent definitions, and skills.

Score each workspace from 0-100 across clarity, specificity, structure, completeness, staleness, redundancy, and actionability. Include concise findings and missing files.

Respond as JSON: {"items":[{"workspaceId":"...","overallScore":0,"categoryScores":{"clarity":0,"specificity":0,"structure":0,"completeness":0,"staleness":0,"redundancy":0,"actionability":0},"findings":[{"category":"clarity","severity":"good|warning|critical","file":"path","finding":"what","suggestion":"how"}],"missingFiles":[{"filename":"...","reason":"...","impact":"high|medium|low"}],"summary":"..."}]}`;

  const workspaceData = payloads.map(payload => {
    const contextSection = payload.contextFiles.length > 0
      ? payload.contextFiles.map(file => {
        const content = file.content || '(empty)';
        const truncated = content.length > 3000 ? `${content.slice(0, 3000)}\n...(truncated)` : content;
        return `--- ${file.path} (${file.lines} lines) ---\n${truncated}`;
      }).join('\n\n')
      : '(No context files found)';

    return `=== Workspace: ${payload.workspaceName} (id: ${payload.workspaceId}, harness: ${payload.harness}) ===

File tree:
${payload.fileTree || '(not available)'}

${payload.readmeSnippet ? `README:\n${payload.readmeSnippet}\n` : ''}${payload.packageSnippet ? `Project config:\n${payload.packageSnippet}\n` : ''}Context files:
${contextSection}`;
  }).join('\n\n');

  const response = await callLocalLlmJson<{ items?: Array<Record<string, unknown>> }>([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Review these ${payloads.length} workspace(s):\n${workspaceData}` },
  ]);

  const rawItems = responseItems(response);
  const validCategories = new Set(categories);
  return {
    reviews: rawItems.map(item => {
      const categoryScoresRaw = asRecord(item.categoryScores);
      const categoryScores: Record<string, number> = {};
      for (const category of categories) {
        const value = categoryScoresRaw[category];
        categoryScores[category] = isNumber(value) ? Math.min(100, Math.max(0, value)) : 0;
      }
      const workspaceId = toText(item.workspaceId);
      const workspace = payloads.find(payload => payload.workspaceId === workspaceId);
      const findings = Array.isArray(item.findings)
        ? (item.findings as unknown[]).map(findingRaw => {
          const finding = asRecord(findingRaw);
          const category = toText(finding.category);
          const severity = toText(finding.severity);
          return {
            category: validCategories.has(category) ? category : 'clarity',
            severity: ['good', 'warning', 'critical'].includes(severity) ? severity : 'warning',
            file: toText(finding.file),
            finding: toText(finding.finding),
            suggestion: toText(finding.suggestion),
          };
        })
        : [];
      return {
        workspaceId,
        workspaceName: workspace?.workspaceName || workspaceId,
        overallGrade: gradeForScore(isNumber(item.overallScore) ? item.overallScore : 0),
        overallScore: isNumber(item.overallScore) ? Math.min(100, Math.max(0, item.overallScore)) : 0,
        categoryScores,
        findings,
        summary: toText(item.summary),
      };
    }),
  };
}

function gradeForScore(score: number): string {
  if (score >= 80) return 'A';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

function getUserContext(parseResult?: ParseResult): { languages: string[]; harnesses: string[]; topics: string[]; workspaces: string[] } {
  if (!parseResult) return { languages: [], harnesses: [], topics: [], workspaces: [] };
  const sessions = parseResult.sessions;
  const langCounts = new Map<string, number>();
  for (const session of sessions) {
    for (const request of session.requests) {
      for (const block of [...request.aiCode, ...request.userCode]) {
        if (block.language && block.language !== 'unknown' && block.language !== 'text') {
          langCounts.set(block.language, (langCounts.get(block.language) || 0) + block.loc);
        }
      }
    }
  }
  const languages = Array.from(langCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(entry => entry[0]);
  const harnesses = Array.from(new Set(sessions.map(session => session.harness))).filter(Boolean);
  const workspaces = Array.from(new Set(sessions.map(session => session.workspaceName))).filter(Boolean).slice(0, 10);
  const topicKeywords = ['test', 'deploy', 'docker', 'kubernetes', 'ci', 'api', 'auth', 'database', 'migration', 'refactor', 'debug', 'security', 'performance', 'react', 'node', 'python', 'rust', 'go', 'java', 'terraform', 'azure', 'aws', 'vite', 'eslint'];
  const topicCounts = new Map<string, number>();
  for (const session of sessions) {
    for (const request of session.requests) {
      const lower = request.messageText.toLowerCase();
      for (const keyword of topicKeywords) {
        if (lower.includes(keyword)) topicCounts.set(keyword, (topicCounts.get(keyword) || 0) + 1);
      }
    }
  }
  const topics = Array.from(topicCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(entry => entry[0]);
  return { languages, harnesses, topics, workspaces };
}

async function generateRule(params: unknown): Promise<unknown> {
  const p = asRecord(params);
  const prompt = isString(p.prompt) ? p.prompt : '';
  const id = slugify(prompt.substring(0, 40), 'custom-rule');
  const messages: LocalLlmMessage[] = [
    { role: 'system', content: buildRuleSystemPrompt() },
    { role: 'user', content: `Generate a complete detection rule for: ${prompt}\n\nUse id: ${id}` },
  ];

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await callLocalLlm(messages);
      const markdown = cleanRuleMarkdown(result);
      const issues = validateRuleMarkdown(markdown);
      if (issues.length === 0) return { markdown };
      messages.push({ role: 'assistant', content: result });
      messages.push({
        role: 'user',
        content: `The generated rule has issues:\n${issues.map(issue => `- ${issue}`).join('\n')}\n\nPlease fix and output the complete corrected rule markdown. No code fences around the output.`,
      });
    }
    return { markdown: cleanRuleMarkdown(await callLocalLlm(messages)) };
  } catch {
    return { markdown: ruleTemplate(id, prompt || 'Custom rule') };
  }
}

function buildRuleSystemPrompt(): string {
  return `You are an expert at writing detection rules for AI Engineer Coach.
Rules are markdown files with YAML frontmatter and a Detection Logic block using a custom DSL.

${DSL_CHEATSHEET}

Required sections:
- YAML frontmatter: id, name, group, severity, scope, version, tags, thresholds
- # Description
- # When Triggered
- # How to Improve
- # Examples
- # Detection Logic with a \`\`\`detect block

Use one of these groups: prompt-quality, session-hygiene, code-review, tool-mastery, context-management.
Use scope requests or sessions.
Always use thresholds for configurable values.

Output only the raw markdown rule. No code fences around the whole output. No explanation.`;
}

function cleanRuleMarkdown(raw: string): string {
  let markdown = raw.trim();
  markdown = markdown.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const frontmatterIndex = markdown.indexOf('---');
  if (frontmatterIndex > 0) markdown = markdown.substring(frontmatterIndex);
  return markdown;
}

function validateRuleMarkdown(markdown: string): string[] {
  const issues: string[] = [];
  if (!markdown.match(/^---\n/)) issues.push('Missing YAML frontmatter');
  if (!markdown.match(/\n---\n/)) issues.push('Frontmatter not closed');
  if (!markdown.match(/^id:\s*.+/m)) issues.push('Missing id field');
  if (!markdown.match(/^name:\s*.+/m)) issues.push('Missing name field');
  if (!markdown.match(/^group:\s*(prompt-quality|session-hygiene|code-review|tool-mastery|context-management)/m)) issues.push('Missing or invalid group');
  if (!markdown.match(/^severity:\s*(low|medium|high)/m)) issues.push('Missing or invalid severity');
  if (!markdown.match(/^scope:\s*(requests|sessions)/m)) issues.push('Missing or invalid scope');
  if (!markdown.includes('# Description')) issues.push('Missing Description section');
  if (!markdown.includes('# When Triggered')) issues.push('Missing When Triggered section');
  if (!markdown.includes('# How to Improve')) issues.push('Missing How to Improve section');
  if (!markdown.includes('```detect')) issues.push('Missing Detection Logic block');
  return issues;
}

function ruleTemplate(id: string, prompt: string): string {
  return `---
id: ${id}
name: ${prompt.substring(0, 60)}
group: prompt-quality
severity: medium
scope: requests
version: 1
tags: [custom]
thresholds:
  minReqs: 5
---

# Description
${prompt}

# When Triggered
{{count}} occurrences detected out of {{total}} ({{pct}}).

# How to Improve
Review flagged items and adjust your workflow to avoid this pattern.

# Examples
"{{message}}..."

# Detection Logic
\`\`\`detect
scan: requests
match: messageLength > 0
aggregate: count
check: count >= thresholds.minReqs
examples: "{{messageText | truncate:60}}"
\`\`\`
`;
}

async function explainOccurrence(params: unknown, analyzer?: Analyzer): Promise<unknown> {
  if (!analyzer) return { ok: false, explanation: '', error: 'Analyzer not ready.' };
  const p = asRecord(params);
  const ruleId = isString(p.ruleId) ? p.ruleId : '';
  const sessionId = isString(p.sessionId) ? p.sessionId : '';
  if (!ruleId || !sessionId) return { ok: false, explanation: '', error: 'Missing ruleId or sessionId' };

  const rule = getRule(ruleId);
  if (!rule) return { ok: false, explanation: '', error: 'Rule not found' };
  const filter = isRecord(p.filter) ? validateDateFilter(p.filter) : undefined;
  const session = analyzer.filterSessions(filter).find(item => item.sessionId === sessionId);
  if (!session) return { ok: false, explanation: '', error: 'Session not found' };

  const systemPrompt = `You explain why a specific coding session triggered an AI Engineer Coach detection rule.
Explain in 2-4 short sentences:
1. What the rule is looking for
2. Which specific aspects of this session match the rule
3. One concrete action the user can take

Be specific. Keep it under 80 words. No preamble.`;

  const userPrompt = `Rule: ${rule.name}
Description: ${rule.description}

Rule DSL:
${rule.rawSource || serializeRule(rule)}

Session summary:
${JSON.stringify(buildOccurrenceSessionSummary(session), null, 2)}

Explain why this session triggered the rule.`;

  const explanation = await callLocalLlm([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
  return { ok: true, explanation: explanation.trim() };
}

function buildOccurrenceSessionSummary(session: Session): {
  sessionId: string;
  workspaceName: string;
  requestCount: number;
  harness: string;
  firstMessage: string;
  firstReferencedFiles: string[];
  firstAgentMode: string;
  firstSlashCommand: string;
  totalAiLoc: number;
  modelsUsed: string[];
  messagePreviews: string[];
} {
  const firstReq = session.requests[0];
  return {
    sessionId: session.sessionId,
    workspaceName: session.workspaceName,
    requestCount: session.requestCount,
    harness: session.harness,
    firstMessage: firstReq ? toText(firstReq.messageText).substring(0, 500) : '',
    firstReferencedFiles: firstReq?.referencedFiles?.slice(0, 5) || [],
    firstAgentMode: firstReq?.agentMode || '',
    firstSlashCommand: firstReq?.slashCommand || '',
    totalAiLoc: session.requests.reduce((sum, request) => sum + (request.aiCode?.reduce((inner, code) => inner + (code.loc || 0), 0) || 0), 0),
    modelsUsed: [...new Set(session.requests.map(request => request.modelId).filter(Boolean))].slice(0, 5),
    messagePreviews: session.requests.slice(0, 5).map(request => toText(request.messageText).substring(0, 120)),
  };
}

export function localAiUnavailablePayload(): unknown {
  return errorResult(localLlmUnavailableMessage());
}
