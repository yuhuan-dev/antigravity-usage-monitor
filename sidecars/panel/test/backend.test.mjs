import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {backendHarness} from './backend-harness.mjs';
import {
  getNodeSqliteDatabaseSync,
  parseAnnotationPbtxtTitle,
  readAnnotationTitleForCascade,
  readLocalSqliteTrajectory,
  readLocalSummaryIndex,
} from '../backend/cli-sqlite-reader.mjs';
import { writeTrajectoryCacheFile } from '../backend/trajectory-cache-file.mjs';

const raw={trajectory:{steps:[{status:'CORTEX_STEP_STATUS_DONE',metadata:{
  createdAt:'2026-01-01T00:00:00Z',finishedGeneratingAt:'2026-01-01T00:00:10Z',
  modelUsage:{inputTokens:'100',cacheReadTokens:'200',outputTokens:'600',thinkingOutputTokens:'100',responseOutputTokens:'500'},
},plannerResponse:{response:'answer',thinkingDuration:'5s'}}],generatorMetadata:[{stepIndices:[0],chatModel:{timeToFirstToken:'3s',streamingDuration:'7s'}}]}};
const old={signature:'v5:old',title:'test',steps:[{stepIndex:0,modelKey:'MODEL_PLACEHOLDER_M418',inputTokens:100,cacheReadTokens:200,outputTokens:600,thinkingTokens:100,responseTokens:500,createdAtMs:1767225600000,ttftSec:0.4,streamTokPerSec:200,streamTokens:500,streamDurationSec:2.5,totalDurationSec:10,totalTokPerSec:60}]};

test('trajectory checkpoints preserve updated metadata and ignore bytes replaced by another writer', () => {
  const directory = mkdtempSync(fileURLToPath(new URL('./.checkpoint-', import.meta.url)));
  const file = join(directory, 'trajectory_usage_cache.json');
  const state = {
    '会话📝': { title: 'first', steps: [{ stepIndex: 1, model: '模型', inputTokens: 10 }] },
    second: { title: 'second', steps: [{ stepIndex: 2, outputTokens: 4 }] },
  };
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  try {
    writeTrajectoryCacheFile(file, state);
    assert.deepEqual(read(), state);
    state['会话📝'].title = 'new metadata';
    state.second.steps = [{ stepIndex: 2, outputTokens: 8 }];
    writeTrajectoryCacheFile(file, state);
    assert.deepEqual(read(), state);

    const external = read();
    external['会话📝'].steps[0].inputTokens = 90;
    writeFileSync(file, JSON.stringify(external));
    writeTrajectoryCacheFile(file, state);
    assert.deepEqual(read(), state);

    writeTrajectoryCacheFile(file, {});
    assert.deepEqual(read(), {});
    assert.deepEqual(readdirSync(directory), ['trajectory_usage_cache.json']);
  } finally {
    if (existsSync(file)) unlinkSync(file);
    rmdirSync(directory);
  }
});

test('failed migration retains all accounting, makes legacy speed and TTFT unavailable',async()=>{
  const h=backendHarness({cache:{test:old},trajectories:{test:new Error('offline')}});
  const p=await h.buildTelemetryPayloadInternal('test');
  assert.equal(p.activeConversation.latestTokPerSec,null);
  assert.equal(p.activeConversation.latestTtftSec,null);
  assert.equal(p.activeConversation.avgTokPerSec,null);
  assert.equal(p.activeConversation.recentSteps[0].outputTokens,600);
  assert.equal(p.consumption.session.totalTokens,900);
  assert.equal(p.modelBreakdown[0].avgTokPerSec,null);
  assert.equal(h.state.saves.length,1);
  assert.equal(h.state.saves[0].data.test.steps[0].outputTokens,600);
  assert.equal(h.state.saves[0].data.test.steps[0].modelKey,'unknown');
});
test('successful migration rebuilds measurements and uses the same mean in both tables',async()=>{
  const h=backendHarness({cache:{test:old},trajectories:{test:raw}});
  const p=await h.buildTelemetryPayloadInternal('test');
  assert.equal(p.activeConversation.latestTokPerSec,60);
  assert.equal(p.activeConversation.latestTtftSec,3);
  assert.equal(p.activeConversation.avgTokPerSec,60);
  assert.equal(p.modelBreakdown[0].avgTokPerSec,60);
  assert.equal(p.modelBreakdown[0].speedSummary.sampleCount,1);
  assert.equal(p.consumption.session.totalTokens,900);
  assert.match(h.state.saves[0].data.test.signature,/^v10-model-identity:/);
});
test('a legacy stream setting cannot re-enable mixed speed formulas',async()=>{
  const h=backendHarness({cache:{test:old},trajectories:{test:raw},settings:{speedMode:'stream'}});
  const p=await h.buildTelemetryPayloadInternal('test');
  assert.equal(p.activeConversation.latestTokPerSec,60);
  assert.equal(p.activeConversation.avgTokPerSec,60);
  assert.equal(p.modelBreakdown[0].avgTokPerSec,60);
  assert.equal(p.settings.speedMode,undefined);
});
test('a malformed successful RPC cannot erase previously recorded usage',async()=>{
  const h=backendHarness({cache:{test:old},trajectories:{test:{}}});
  const p=await h.buildTelemetryPayloadInternal('test');
  assert.equal(p.consumption.session.totalTokens,900);
  assert.equal(p.activeConversation.latestTtftSec,null);
  assert.equal(h.state.saves.length,1);
  assert.equal(h.state.saves[0].data.test.steps[0].outputTokens,600);
  assert.equal(h.state.saves[0].data.test.steps[0].modelKey,'unknown');
});
test('a partial trajectory cannot replace a complete historical cache',async()=>{
  const h=backendHarness({cache:{test:old},trajectories:{test:{trajectory:{steps:[]},numTotalSteps:3}}});
  const p=await h.buildTelemetryPayloadInternal('test');
  assert.equal(p.consumption.session.totalTokens,900);
  assert.equal(h.state.saves.length,1);
  assert.equal(h.state.saves[0].data.test.steps[0].outputTokens,600);
  assert.equal(h.state.saves[0].data.test.steps[0].modelKey,'unknown');
  assert.match(h.state.errors[0],/Incomplete trajectory/);
});

test('a TTFT-only correction is persisted even when usage, duration and signature match',async()=>{
  const h=backendHarness({cache:{test:old},trajectories:{test:raw},summaries:{test:{
    stepCount:1,lastModifiedTime:'2026-01-01T00:00:10Z',status:'CASCADE_RUN_STATUS_RUNNING',
  }}});
  await h.buildTelemetryPayloadInternal('test');
  h.state.trajectories.test=structuredClone(raw);
  h.state.trajectories.test.trajectory.generatorMetadata[0].chatModel.timeToFirstToken='9s';
  const next=await h.buildTelemetryPayloadInternal('test');
  assert.equal(next.activeConversation.latestTtftSec,9);
  assert.equal(h.state.saves.length,2);
  assert.equal(h.state.saves[1].data.test.steps[0].ttftSec,9);
});

test('groups subagents under root conversation and computes both per-agent and aggregated telemetry',async()=>{
  const subRaw={trajectory:{steps:[{status:'CORTEX_STEP_STATUS_DONE',metadata:{
    createdAt:'2026-01-01T00:00:20Z',finishedGeneratingAt:'2026-01-01T00:00:25Z',
    modelUsage:{inputTokens:'300',cacheReadTokens:'400',outputTokens:'250',thinkingOutputTokens:'50',responseOutputTokens:'200'},
  },plannerResponse:{response:'sub answer',thinkingDuration:'1s'}}],generatorMetadata:[{stepIndices:[0],chatModel:{timeToFirstToken:'1s',streamingDuration:'4s',chatStartMetadata:{contextWindowMetadata:{tokenBreakdown:{groups:[{type:'TOKEN_TYPE_CHAT_MESSAGES',numTokens:12000},{type:'TOKEN_TYPE_TOOLS',numTokens:3000}]}}}}}]}};
  const h=backendHarness({
    trajectories:{root1:raw,sub1:subRaw},
    summaries:{
      root1:{stepCount:1,lastModifiedTime:'2026-01-01T00:00:10Z',status:'IDLE',annotations:{title:'Root Task'}},
      sub1:{stepCount:1,createdTime:'2026-01-01T00:00:20Z',lastModifiedTime:'2026-01-01T00:00:25Z',status:'CASCADE_RUN_STATUS_RUNNING',trajectoryMetadata:{rootConversationId:'root1',parentConversationId:'root1',subagentSpec:{typeName:'research',role:'Codebase Researcher'}}},
    },
  });
  const p=await h.buildTelemetryPayloadInternal('');
  // Top-level conversations list only contains root1, not raw sub1
  assert.equal(p.conversations.length,1);
  assert.equal(p.conversations[0].cascadeId,'root1');
  assert.equal(p.conversations[0].subagentCount,1);
  assert.equal(p.conversations[0].totalStepCount,2);
  // Active conversation has both individual agents and aggregated view
  assert.equal(p.activeConversation.hasSubagents,true);
  assert.equal(p.activeConversation.subagentCount,1);
  assert.equal(p.activeConversation.agents.length,2);
  assert.equal(p.activeConversation.agents[0].agentId,'main');
  assert.equal(p.activeConversation.agents[0].stepCount,1);
  assert.equal(p.activeConversation.agents[1].agentId,'sub1');
  assert.equal(p.activeConversation.agents[1].role,'Codebase Researcher');
  assert.equal(p.activeConversation.agents[1].context.messagesTokens,12000);
  assert.equal(p.activeConversation.aggregated.stepCount,2);
  assert.equal(p.activeConversation.aggregated.isRunning,true);
  assert.equal(p.activeConversation.aggregated.activeAgentId,'sub1');
  // Session consumption includes both root1 (900) and sub1 (950)
  assert.equal(p.consumption.session.totalTokens,1850);
});

test('discovers and links subagents from parent invokeSubagent steps after Antigravity restart when omitted from trajectorySummaries',async()=>{
  const rootWithInvoke={
    trajectory:{
      metadata:{rootConversationId:'root-audit'},
      steps:[
        {
          status:'CORTEX_STEP_STATUS_DONE',
          metadata:{
            createdAt:'2026-01-01T00:00:00Z',
            finishedGeneratingAt:'2026-01-01T00:00:10Z',
            modelUsage:{inputTokens:'100',cacheReadTokens:'200',outputTokens:'600',thinkingOutputTokens:'100',responseOutputTokens:'500'},
          },
          plannerResponse:{response:'spawning subagents',thinkingDuration:'5s'},
        },
        {
          type:'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
          status:'CORTEX_STEP_STATUS_DONE',
          metadata:{
            createdAt:'2026-01-01T00:00:12Z',
            toolCall:{name:'invoke_subagent',argumentsJson:JSON.stringify({Role:'Build & Baseline Verifier',TypeName:'issue_verifier'})},
          },
          invokeSubagent:{
            subagents:[{typeName:'issue_verifier',role:'Build & Baseline Verifier',initialPrompt:'long prompt...'}],
            results:[{conversationId:'sub-cached-1'}],
          },
        },
        {
          type:'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
          status:'CORTEX_STEP_STATUS_DONE',
          metadata:{
            createdAt:'2026-01-01T00:00:15Z',
            toolCall:{name:'invoke_subagent',argumentsJson:JSON.stringify({Role:'P0 Disk Quiz Patch Verifier',TypeName:'issue_verifier'})},
          },
          invokeSubagent:{
            subagents:[{typeName:'issue_verifier',role:'P0 Disk Quiz Patch Verifier',initialPrompt:'long prompt 2...'}],
            results:[{conversationId:'sub-uncached-2'}],
          },
        },
      ],
      generatorMetadata:[{stepIndices:[0],chatModel:{timeToFirstToken:'3s',streamingDuration:'7s'}}],
    },
  };
  const sub2Raw={
    trajectory:{
      metadata:{
        parentConversationId:'root-audit',
        rootConversationId:'root-audit',
        subagentSpec:{typeName:'issue_verifier',role:'P0 Disk Quiz Patch Verifier',initialPrompt:'huge prompt'},
      },
      steps:[{
        status:'CORTEX_STEP_STATUS_DONE',
        metadata:{
          createdAt:'2026-01-01T00:00:20Z',
          finishedGeneratingAt:'2026-01-01T00:00:25Z',
          modelUsage:{inputTokens:'400',cacheReadTokens:'600',outputTokens:'300',thinkingOutputTokens:'50',responseOutputTokens:'250'},
        },
        plannerResponse:{response:'sub2 report',thinkingDuration:'1s'},
      }],
      generatorMetadata:[{stepIndices:[0],chatModel:{timeToFirstToken:'1s',streamingDuration:'4s'}}],
    },
  };
  // Simulate pre-existing v10 cache entries saved before subagentRefs existed
  const preCachedSub1Step={
    stepIndex:1,
    createdAt:'2026-01-01T00:00:14Z',
    createdAtMs:Date.parse('2026-01-01T00:00:14Z'),
    modelKey:'MODEL_PLACEHOLDER_M417',
    responseModel:'gemini-3.1-pro-high',
    modelIdentityVersion:2,
    modelSource:'explicit',
    inputTokens:200,
    cacheReadTokens:300,
    outputTokens:500,
    thinkingTokens:100,
    responseTokens:400,
    contextBreakdown:{messagesTokens:18000,userInputTokens:2000,assistantTokens:6000,toolResultsTokens:10000,subagentTokens:0,checkpointTokens:0,systemToolsTokens:4000,mcpToolsTokens:0,skillsTokens:1000,systemPromptTokens:5000,userRulesTokens:2000},
  };
  const h=backendHarness({
    cache:{
      'root-audit':{
        signature:'v10-model-identity:3:2026-01-01T00:00:15Z',
        title:'Frontend Issue Audit Verification',
        lastModifiedMs:Date.parse('2026-01-01T00:00:15Z'),
        steps:[{...preCachedSub1Step,inputTokens:100,cacheReadTokens:200,outputTokens:600}],
      },
      'sub-cached-1':{
        signature:'v10-model-identity:disk:1767225614000',
        title:'sub-cach',
        lastModifiedMs:Date.parse('2026-01-01T00:00:14Z'),
        steps:[preCachedSub1Step],
      },
    },
    trajectories:{
      'root-audit':rootWithInvoke,
      'sub-uncached-2':sub2Raw,
    },
    // After restart, GetAllCascadeTrajectories only returns root-audit!
    summaries:{
      'root-audit':{
        stepCount:3,
        lastModifiedTime:'2026-01-01T00:00:15Z',
        status:'IDLE',
        annotations:{title:'Frontend Issue Audit Verification'},
      },
    },
  });

  const p=await h.buildTelemetryPayloadInternal('root-audit');
  assert.equal(p.conversations.length,1);
  assert.equal(p.conversations[0].cascadeId,'root-audit');
  assert.equal(p.conversations[0].subagentCount,2);
  assert.equal(p.activeConversation.hasSubagents,true);
  assert.equal(p.activeConversation.subagentCount,2);
  assert.equal(p.activeConversation.agents.length,3);
  assert.equal(p.activeConversation.agents[1].agentId,'sub-cached-1');
  assert.equal(p.activeConversation.agents[1].role,'Build & Baseline Verifier');
  assert.equal(p.activeConversation.agents[1].context.messagesTokens,18000);
  assert.equal(p.activeConversation.agents[2].agentId,'sub-uncached-2');
  assert.equal(p.activeConversation.agents[2].role,'P0 Disk Quiz Patch Verifier');
  assert.equal(p.activeConversation.aggregated.stepCount,3);
  // Verify initialPrompt was stripped from persisted cache
  const savedSub2=h.state.saves[h.state.saves.length-1].data['sub-uncached-2'];
  assert.equal(savedSub2.subagentSpec.initialPrompt,undefined);
  assert.equal(savedSub2.subagentSpec.role,'P0 Disk Quiz Patch Verifier');
  // Conversation dropdown stepCount matches model step count (1, not 3 raw steps)
  assert.equal(p.conversations[0].stepCount,1);
  assert.equal(p.conversations[0].totalStepCount,3);
});

test('converges multi-level nested subagents to ultimate root and preserves metrics when a newly spawned subagent has 0 steps',async()=>{
  const rootTraj={
    trajectory:{
      steps:[
        {
          status:'CORTEX_STEP_STATUS_DONE',
          metadata:{
            createdAt:'2026-01-01T00:00:00Z',
            finishedGeneratingAt:'2026-01-01T00:00:10Z',
            modelUsage:{inputTokens:'100',cacheReadTokens:'200',outputTokens:'600',thinkingOutputTokens:'100',responseOutputTokens:'500'},
          },
          plannerResponse:{response:'root step',thinkingDuration:'5s'},
        },
        {
          type:'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
          status:'CORTEX_STEP_STATUS_DONE',
          metadata:{createdAt:'2026-01-01T00:00:11Z'},
          invokeSubagent:{
            subagents:[{typeName:'self',role:'Level 1 Orchestrator'}],
            results:[{conversationId:'sub-l1'}],
          },
        },
      ],
      generatorMetadata:[{stepIndices:[0],chatModel:{timeToFirstToken:'2s',streamingDuration:'8s'}}],
    },
  };
  const subL1Traj={
    trajectory:{
      metadata:{
        parentConversationId:'root-multi',
        subagentSpec:{typeName:'self'},
      },
      steps:[
        {
          status:'CORTEX_STEP_STATUS_DONE',
          metadata:{
            createdAt:'2026-01-01T00:00:15Z',
            finishedGeneratingAt:'2026-01-01T00:00:20Z',
            modelUsage:{inputTokens:'200',cacheReadTokens:'300',outputTokens:'400',thinkingOutputTokens:'50',responseOutputTokens:'350'},
          },
          plannerResponse:{response:'l1 step',thinkingDuration:'1s'},
        },
        {
          type:'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
          status:'CORTEX_STEP_STATUS_DONE',
          metadata:{createdAt:'2026-01-01T00:00:21Z'},
          invokeSubagent:{
            subagents:[{typeName:'research',role:'Level 2 Deep Worker'}],
            results:[{conversationId:'sub-l2'}],
          },
        },
      ],
      generatorMetadata:[{stepIndices:[0],chatModel:{timeToFirstToken:'1s',streamingDuration:'4s',chatStartMetadata:{contextWindowMetadata:{tokenBreakdown:{groups:[{type:'TOKEN_TYPE_CHAT_MESSAGES',numTokens:24000}]}}}}}],
    },
  };
  // Level 2 subagent is currently running with 0 completed model steps so far
  const subL2Traj={
    trajectory:{
      metadata:{
        parentConversationId:'sub-l1',
        rootConversationId:'sub-l1',
      },
      steps:[],
      generatorMetadata:[],
    },
  };

  const h=backendHarness({
    trajectories:{
      'root-multi':rootTraj,
      'sub-l1':subL1Traj,
      'sub-l2':subL2Traj,
    },
    summaries:{
      'root-multi':{stepCount:2,lastModifiedTime:'2026-01-01T00:00:11Z',status:'IDLE',annotations:{title:'Multi-Level Task'}},
      'sub-l1':{stepCount:2,lastModifiedTime:'2026-01-01T00:00:21Z',status:'IDLE',trajectoryMetadata:{parentConversationId:'root-multi'}},
      'sub-l2':{stepCount:0,lastModifiedTime:'2026-01-01T00:00:25Z',status:'CASCADE_RUN_STATUS_RUNNING',trajectoryMetadata:{parentConversationId:'sub-l1',rootConversationId:'sub-l1'}},
    },
  });

  const p=await h.buildTelemetryPayloadInternal('root-multi');
  assert.equal(p.conversations.length,1);
  assert.equal(p.conversations[0].subagentCount,2);
  assert.equal(p.activeConversation.subagentCount,2);
  assert.equal(p.activeConversation.agents.length,3);
  // Partial subagentSpec ({typeName:'self'}) merged with invokeSubagent role ('Level 1 Orchestrator')
  assert.equal(p.activeConversation.agents[1].role,'Level 1 Orchestrator');
  assert.equal(p.activeConversation.agents[2].agentId,'sub-l2');
  assert.equal(p.activeConversation.agents[2].role,'Level 2 Deep Worker');
  // Even though sub-l2 is running with 0 steps, aggregated telemetry retains valid speed & context from sub-l1
  assert.equal(p.activeConversation.aggregated.activeAgentId,'sub-l2');
  assert.equal(p.activeConversation.aggregated.latestTokPerSec,80);
  assert.equal(p.activeConversation.aggregated.context.messagesTokens,24000);
  // Main agent steps are not duplicated in agents[0].recentSteps or aggregated.recentSteps
  assert.equal(p.activeConversation.agents[0].recentSteps,undefined);
  assert.equal(p.activeConversation.aggregated.recentSteps,undefined);
  // Running sub-l2 with 0 steps still exposes liveActivity on both subagent and aggregated view
  assert.equal(p.activeConversation.agents[0].liveActivity,null);
  assert.equal(p.activeConversation.agents[2].liveActivity.phase,'thinking');
  assert.equal(p.activeConversation.aggregated.liveActivity.agentId,'sub-l2');
  assert.equal(p.activeConversation.aggregated.liveActivity.agentBadge,'子2');
  // runningConversations includes root-multi with main summary and collapsible subagents summary
  assert.equal(p.runningConversations.length,1);
  assert.equal(p.runningConversations[0].cascadeId,'root-multi');
  assert.equal(p.runningConversations[0].title,'Multi-Level Task');
  assert.equal(p.runningConversations[0].subagentCount,2);
  assert.equal(p.runningConversations[0].runningSubagentCount,1);
  assert.equal(p.runningConversations[0].mainActivity.label,'等待子代理');
  assert.equal(p.runningConversations[0].subagents[0].role,'Level 1 Orchestrator');
  assert.equal(p.runningConversations[0].subagents[0].isRunning,false);
  assert.equal(p.runningConversations[0].subagents[0].liveActivity.label,'已完成');
  assert.equal(p.runningConversations[0].subagents[1].role,'Level 2 Deep Worker');
  assert.equal(p.runningConversations[0].subagents[1].isRunning,true);
});

test('trendSeries buckets hourly for <=72h windows (today/24h) and daily for >72h windows (7d)', async () => {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs - 5000).toISOString();
  const finIso = new Date(nowMs).toISOString();
  const h = backendHarness({
    trajectories: {
      c1: {
        trajectory: {
          steps: [
            {
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: nowIso,
                finishedGeneratingAt: finIso,
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M37',
                  inputTokens: '100',
                  cacheReadTokens: '200',
                  outputTokens: '600',
                  thinkingOutputTokens: '100',
                  responseOutputTokens: '500',
                },
              },
              plannerResponse: { response: 'answer', thinkingDuration: '2s' },
            },
          ],
          generatorMetadata: [{ stepIndices: [0], chatModel: { timeToFirstToken: '1s', streamingDuration: '4s' } }],
        },
      },
    },
    summaries: {
      c1: { stepCount: 1, lastModifiedTime: finIso, status: 'IDLE' },
    },
  });

  const p24h = await h.buildTelemetryPayloadInternal('c1', false, { range: '24h' });
  const trend24h = p24h.consumption.trendSeries;
  assert.ok(trend24h.length >= 24 && trend24h.length <= 26);
  assert.equal(trend24h[0].granularity, 'hour');
  assert.match(trend24h[0].fullLabel, /\d+月\d+日 \d{2}:00 - \d{2}:00/);
  assert.equal(trend24h.reduce((sum, b) => sum + b.tokens, 0), 900);
  assert.equal(trend24h.reduce((sum, b) => sum + b.calls, 0), 1);

  const p7d = await h.buildTelemetryPayloadInternal('c1', false, { range: '7d' });
  const trend7d = p7d.consumption.trendSeries;
  assert.ok(trend7d.length >= 7 && trend7d.length <= 8);
  assert.equal(trend7d[0].granularity, 'day');
  assert.match(trend7d[0].fullLabel, /\d+月\d+日 \(周[日一二三四五六]\)/);
  assert.equal(trend7d.reduce((sum, b) => sum + b.tokens, 0), 900);
});

test('supports Gemini 4 Carbon pricing/pool and resolves all newly added language_server placeholder enums', async () => {
  const nowIso = new Date().toISOString();
  const h = backendHarness({
    userStatus: {
      name: 'Carbon Tester',
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 3.8 Flash (High)',
            modelId: 'gemini-3.8-flash-high',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' },
            quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-12T00:00:00Z' },
          },
          {
            label: 'Gemini 4 Carbon (High)',
            modelId: 'gemini-4-carbon-high',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M429' },
            quotaInfo: { remainingFraction: 0.65, resetTime: '2026-11-17T00:00:00Z' },
          },
        ],
      },
    },
    trajectories: {
      cCarbon: {
        trajectory: {
          steps: [
            {
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: '2026-11-10T00:00:00Z',
                finishedGeneratingAt: '2026-11-10T00:00:05Z',
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M298',
                  inputTokens: '1000000',
                  cacheReadTokens: '0',
                  outputTokens: '0',
                },
              },
              plannerResponse: { response: 'flash 3.7 high' },
            },
            {
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: '2026-11-10T00:00:06Z',
                finishedGeneratingAt: '2026-11-10T00:00:10Z',
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M402',
                  inputTokens: '1000000',
                  cacheReadTokens: '0',
                  outputTokens: '0',
                },
              },
              plannerResponse: { response: 'claude opus 5.5 high' },
            },
            {
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: '2026-11-10T00:00:11Z',
                finishedGeneratingAt: '2026-11-10T00:00:15Z',
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M429',
                  inputTokens: '1000000',
                  cacheReadTokens: '1000000',
                  outputTokens: '100000',
                },
              },
              plannerResponse: { response: 'carbon high' },
            },
            {
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: '2026-11-10T00:00:16Z',
                finishedGeneratingAt: '2026-11-10T00:00:20Z',
                modelUsage: {
                  model: 'claude-fable-5-2-high',
                  inputTokens: '1000000',
                  cacheReadTokens: '1000000',
                  outputTokens: '100000',
                },
              },
              plannerResponse: { response: 'fable 5.2 high' },
            },
            {
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: '2026-11-10T00:00:21Z',
                finishedGeneratingAt: '2026-11-10T00:00:25Z',
                modelUsage: {
                  model: 'gpt-6.1-terra',
                  inputTokens: '1000000',
                  cacheReadTokens: '1000000',
                  outputTokens: '100000',
                },
              },
              plannerResponse: { response: 'gpt 6.1 terra' },
            },
            {
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: '2026-11-10T00:00:26Z',
                finishedGeneratingAt: '2026-11-10T00:00:30Z',
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M429',
                  inputTokens: '0',
                  cacheReadTokens: '0',
                  outputTokens: '100',
                },
              },
              plannerResponse: { response: 'carbon tail' },
            },
          ],
          generatorMetadata: [
            { stepIndices: [0], chatModel: { timeToFirstToken: '1s', streamingDuration: '4s' } },
            { stepIndices: [1], chatModel: { timeToFirstToken: '1s', streamingDuration: '3s' } },
            { stepIndices: [2], chatModel: { timeToFirstToken: '1s', streamingDuration: '3s' } },
            { stepIndices: [3], chatModel: { timeToFirstToken: '1s', streamingDuration: '3s' } },
            { stepIndices: [4], chatModel: { timeToFirstToken: '1s', streamingDuration: '3s' } },
            { stepIndices: [5], chatModel: { timeToFirstToken: '1s', streamingDuration: '1s' } },
          ],
        },
      },
    },
    summaries: {
      cCarbon: { stepCount: 6, lastModifiedTime: nowIso, status: 'IDLE' },
    },
  });

  const p = await h.buildTelemetryPayloadInternal('cCarbon');
  assert.equal(p.activeConversation.sessionUnpricedCalls, 0);
  // Step 0: M298 -> Gemini 3.7 Flash ($0.75)
  // Step 1: M402 -> Claude Opus 5.5 ($4.00)
  // Step 2: Carbon High -> 1M*$2.00 + 1M*$0.10 + 0.1M*$10.0 = $3.10
  // Step 3: Fable 5.2 High -> 1M*$8.00 + 1M*$0.20 + 0.1M*$40.0 = $12.20
  // Step 4: GPT-6.1 Terra -> 1M*$1.00 + 1M*$0.05 + 0.1M*$5.0 = $1.55
  // Step 5: Carbon High -> 100 tok * $10/1M = $0.001
  // Total = 0.75 + 4.00 + 3.10 + 12.20 + 1.55 + 0.001 = $21.601 -> $21.60
  assert.equal(p.activeConversation.sessionCostUsd, 21.6);
  assert.equal(p.activeConversation.activeModelShort, 'carbon-4-high');
  assert.equal(p.quotas.activePool.poolKey, 'Carbon');
  assert.equal(p.quotas.activePool.weeklyRemainingIntPct, 65);
});

test('trendSeries preserves 1-day-per-slot granularity for >90 day spans and recentSteps separates thinking vs response tokens', async () => {
  const nowMs = Date.now();
  const oldStartMs = nowMs - 120 * 24 * 3600 * 1000;
  const oldStartIso = new Date(oldStartMs).toISOString();
  const oldEndIso = new Date(oldStartMs + 6000).toISOString();
  const recentStartIso = new Date(nowMs - 8000).toISOString();
  const recentEndIso = new Date(nowMs - 1000).toISOString();

  const h = backendHarness({
    trajectories: {
      cLong: {
        trajectory: {
          steps: [
            {
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                sourceTrajectoryStepInfo: { stepIndex: 1 },
                createdAt: oldStartIso,
                finishedGeneratingAt: oldEndIso,
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M429',
                  inputTokens: '10000',
                  cacheReadTokens: '20000',
                  outputTokens: '700',
                  thinkingOutputTokens: '420',
                },
              },
              plannerResponse: { response: 'early step' },
            },
            {
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                sourceTrajectoryStepInfo: { stepIndex: 2 },
                createdAt: recentStartIso,
                finishedGeneratingAt: recentEndIso,
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M429',
                  inputTokens: '5000',
                  cacheReadTokens: '32115',
                  outputTokens: '685',
                  thinkingOutputTokens: '420',
                  responseOutputTokens: '265',
                },
              },
              plannerResponse: { response: 'recent step' },
            },
          ],
        },
      },
    },
    summaries: {
      cLong: { stepCount: 2, lastModifiedTime: recentEndIso, status: 'IDLE' },
    },
  });

  const pAll = await h.buildTelemetryPayloadInternal('cLong', false, { range: 'all' });
  const trendAll = pAll.consumption.trendSeries;
  assert.ok(trendAll.length >= 120 && trendAll.length <= 122, `Expected ~121 daily slots, got ${trendAll.length}`);
  assert.equal(trendAll[0].granularity, 'day');
  assert.match(trendAll[0].fullLabel, /^\d{4}年\d+月\d+日 \(周[日一二三四五六]\)$/);
  assert.equal(trendAll.reduce((sum, b) => sum + b.tokens, 0), 30700 + 37800);
  assert.equal(trendAll.reduce((sum, b) => sum + b.calls, 0), 2);

  const steps = pAll.activeConversation.recentSteps;
  assert.equal(steps.length, 2);
  // recentSteps is reversed (newest first)
  assert.equal(steps[0].contextTokens, 37800);
  assert.equal(steps[0].thinkingTokens, 420);
  assert.equal(steps[0].responseTokens, 265);
  assert.equal(steps[1].thinkingTokens, 420);
  assert.equal(steps[1].responseTokens, 280);
});

test('cached incomplete timing is refreshed once without invalidating completed historical steps', async () => {
  const time = '2026-01-01T00:00:12Z';
  const summary = { stepCount: 1, lastModifiedTime: time, status: 'IDLE' };
  const incompleteStep = {
    ...structuredClone(raw.trajectory.steps[0]),
    status: 'CORTEX_STEP_STATUS_CLEARED',
  };
  const { extractModelSteps } = await import('../trajectory-metrics.mjs');
  const [completed] = extractModelSteps(raw.trajectory.steps, raw.trajectory.generatorMetadata);
  const [incomplete] = extractModelSteps([{ ...incompleteStep, status: 'CORTEX_STEP_STATUS_GENERATING' }]);
  const cacheEntry = (step) => ({
    signature: `v10-model-identity:1:${time}`,
    steps: [step],
    contextLimitTelemetry: true,
    subagentRefs: [],
  });
  const h = backendHarness({
    cache: { repaired: cacheEntry(incomplete), stable: cacheEntry(completed) },
    summaries: { repaired: summary, stable: summary },
    trajectories: { repaired: { trajectory: { ...raw.trajectory, steps: [incompleteStep] } } },
  });

  for (let i = 0; i < 2; i++) {
    const result = await h.buildTelemetryPayloadInternal('repaired');
    assert.equal(result.activeConversation.latestTokPerSec, Math.round(completed.totalTokPerSec * 10) / 10);
  }
  assert.deepEqual(
    h.state.calls.filter((c) => c.method === 'GetCascadeTrajectory').map((c) => c.body.cascadeId),
    ['repaired']
  );
});

test('unchanged running steps skip cache writes, but corrected timing with the same summary is persisted', async () => {
  const time = '2026-01-01T00:00:10Z';
  const live = structuredClone(raw);
  live.trajectory.steps[0].status = 'CORTEX_STEP_STATUS_GENERATING';
  const h = backendHarness({
    trajectories: { live },
    summaries: { live: { stepCount: 1, lastModifiedTime: time, status: 'CASCADE_RUN_STATUS_RUNNING' } },
  });

  const pending = await h.buildTelemetryPayloadInternal('live');
  assert.equal(pending.activeConversation.latestTokPerSec, null);
  const writes = h.state.saves.length;
  assert.ok(writes > 0);

  await h.buildTelemetryPayloadInternal('live');
  assert.equal(h.state.saves.length, writes);

  h.state.trajectories.live = raw;
  const completed = await h.buildTelemetryPayloadInternal('live');
  assert.equal(completed.activeConversation.latestTokPerSec, 60);
  assert.equal(h.state.saves.length, writes + 1);
  assert.equal(h.state.saves.at(-1).data.live.steps[0].totalTokPerSec, 60);
});

test('display step revisions omit only matching rows and invalidate on timing changes', async () => {
  const time = '2026-01-01T00:00:10Z';
  const live = structuredClone(raw);
  live.trajectory.steps[0].status = 'CORTEX_STEP_STATUS_GENERATING';
  const h = backendHarness({
    trajectories: { live },
    summaries: { live: { stepCount: 1, lastModifiedTime: time, status: 'CASCADE_RUN_STATUS_RUNNING' } },
  });
  const request = { conversationId: 'live', stepDetails: 'display' };
  const get = async (stepRevision) => JSON.parse((await h.executeTelemetryAction({
    ...request, stepRevision
  })).body);
  const initial = await get('');
  assert.equal(initial.stepsUnchanged, false);
  assert.equal(initial.activeConversation.recentSteps[0].tokPerSec, null);
  const same = await get(initial.stepRevision);
  assert.equal(same.stepsUnchanged, true);
  assert.equal(same.stepRevision, initial.stepRevision);
  assert.equal(same.activeConversation.recentSteps, undefined);

  h.state.trajectories.live = raw;
  const changed = await get(initial.stepRevision);
  assert.equal(changed.stepsUnchanged, false);
  assert.notEqual(changed.stepRevision, initial.stepRevision);
  assert.equal(changed.activeConversation.recentSteps[0].tokPerSec, 60);
  assert.equal((await get()).activeConversation.recentSteps[0].tokPerSec, 60);
});

test('telemetry reuses display rows only for a matching revision', async (t) => {
  const { fetchTelemetry, telemetryStore } = await import('../src/store/telemetryStore.js');
  const previousTelemetry = telemetryStore.getState().telemetry;
  t.after(() => telemetryStore.setState({ telemetry: previousTelemetry }));
  const recentSteps = [{ stepIndex: 1, tokPerSec: 20 }];
  const agentSteps = [{ stepIndex: 2, tokPerSec: 40 }];
  let response = {
    stepRevision: 'test-revision',
    activeConversation: { recentSteps, agents: [{ recentSteps: agentSteps }] },
  };
  const revisions = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    revisions.push(new URL(url, 'http://localhost').searchParams.get('stepRevision'));
    return { ok: true, json: async () => structuredClone(response) };
  });

  assert.equal((await fetchTelemetry()).stepRevision, 'test-revision');
  response = {
    stepsUnchanged: true,
    stepRevision: 'test-revision',
    activeConversation: { agents: [{}] },
  };
  const refreshed = await fetchTelemetry();
  assert.equal(revisions[1], 'test-revision');
  assert.deepEqual(refreshed.activeConversation.recentSteps, recentSteps);
  assert.deepEqual(refreshed.activeConversation.agents[0].recentSteps, agentSteps);

  const telemetryBeforeMismatch = telemetryStore.getState().telemetry;
  response.stepRevision = 'unknown-revision';
  assert.equal(await fetchTelemetry(), null);
  assert.equal(telemetryStore.getState().telemetry, telemetryBeforeMismatch);
});

test('simultaneous ranges share the trajectory scan while keeping their own totals', async () => {
  const h = backendHarness({
    trajectories: { live: raw },
    summaries: { live: { stepCount: 1, lastModifiedTime: '2026-01-01T00:00:10Z' } },
  });
  const [all, custom] = await Promise.all([
    h.buildTelemetryPayloadInternal('live', false, { range: 'all' }),
    h.buildTelemetryPayloadInternal('live', false, { range: 'custom', startMs: 1, endMs: 2 }),
  ]);
  assert.equal(all.consumption.account.totalTokens, 900);
  assert.equal(custom.consumption.account.totalTokens, 0);
  assert.equal(h.state.calls.filter((call) => call.method === 'GetAllCascadeTrajectories').length, 1);
  assert.equal(h.state.calls.filter((call) => call.method === 'GetCascadeTrajectory').length, 1);
});

test('cached usage follows rolling boundaries and reprices unchanged steps', async () => {
  const { extractModelSteps } = await import('../trajectory-metrics.mjs');
  const [step] = extractModelSteps(raw.trajectory.steps, raw.trajectory.generatorMetadata);
  const modelKey = 'test-metered-model';
  let now = Date.parse('2026-03-08T07:00:00Z');
  const priceCatalog = (price) => ({
    schemaVersion: 1,
    pricing: {
      [modelKey]: { input: price, cache: price, output: price, family: 'Gemini', short: modelKey },
    },
  });
  const h = backendHarness({
    clock: () => now,
    localCatalog: priceCatalog(100),
    cache: {
      live: {
        signature: 'v10-model-identity:disk:0',
        contextLimitTelemetry: true, turnRailTelemetry: true, contextGroupsTelemetry: true,
        speedClearedTelemetry: true, subagentRefs: [],
        steps: [
          { ...step, modelKey, createdAtMs: now - 86400000, turnIndex: null },
          { ...step, modelKey, stepIndex: 2, createdAtMs: now + 1, inputTokens: 120, turnIndex: null },
        ],
      },
    },
  });
  const build = () => h.buildTelemetryPayloadInternal('live', false, { range: '24h' });
  const first = await build();
  assert.equal(first.consumption.account.totalTokens, 900);
  assert.equal(first.consumption.account.costUsd, 0.09);

  now += 1;
  const crossing = await build();
  assert.equal(crossing.consumption.account.totalTokens, 920);
  assert.equal(crossing.consumption.account.calls, 1);

  now += 1;
  h.state.localCatalog = priceCatalog(1000);
  h.rebuildActiveCatalog();
  const repriced = await build();
  assert.equal(repriced.consumption.account.totalTokens, 920);
  assert.equal(repriced.consumption.account.costUsd, 0.92);
  assert.equal(repriced.activeConversation.recentSteps[0].costUsd, 0.92);
});

test('modelBreakdown exposes avgTtftSec, cacheHitPct, and subagent scoped breakdowns + fit math helpers', async () => {
  const {
    computeLinearFit,
    computePublicationFit,
    getStepModelGroupKey,
    toChronologicalSteps,
  } = await import('../src/components/charts/SessionStepCharts.js');

  // 1. Verify OLS + publication LOESS + 95% CI confidence band & [0, 100] cache bounds
  const olsExact = computeLinearFit([10, 20, 30, 40]);
  assert.ok(Math.abs(olsExact.slope - 10) < 1e-9);
  assert.ok(Math.abs(olsExact.r - 1) < 1e-9);
  assert.ok(Math.abs(olsExact.r2 - 1) < 1e-9);
  assert.deepEqual(
    olsExact.values.map((v) => +v.toFixed(4)),
    [10, 20, 30, 40]
  );

  // Verify bimodal / high-peak TPS series is NOT crushed flat by Bisquare and builds valid 95% CI band
  const waveXs = Array.from({ length: 20 }, (_, idx) => idx * 5 + 1);
  const waveYs = [
    22, 26, 48, 78, 92, 85, 64, 34, 24, 28,
    55, 84, 76, 42, 25, 22, 26, 32, 38, 44,
  ];
  const pubWave = computePublicationFit(waveXs, waveYs, { minVal: 0 });
  assert.equal(pubWave.method, 'LOESS');
  assert.equal(pubWave.grid.length, 64);
  assert.ok(
    pubWave.grid.every((g) => g.ciLow <= g.fit + 1e-9 && g.fit <= g.ciHigh + 1e-9),
    'Every grid point satisfies ciLow <= fit <= ciHigh'
  );
  // Around peak x ~ 21 (index 4), fitted conditional expectation must rise well above overall mean (~47)
  assert.ok(pubWave.sampleFits[4] > 55, `Expected peak conditional mean > 55, got ${pubWave.sampleFits[4]}`);

  // Warmup cache curve stays clamped within [0, 100]
  const cacheSeries = [0, 90, 92, 93, 94, 95, 95];
  const loessCache = computePublicationFit(
    cacheSeries.map((_, index) => index),
    cacheSeries,
    { minVal: 0, maxVal: 100 }
  ).sampleFits;
  assert.equal(loessCache.length, cacheSeries.length);
  assert.ok(
    loessCache.every((v) => v >= 0 && v <= 100),
    'Fitted cache values must stay clamped within [0, 100]'
  );
  assert.ok(loessCache[6] > 90, 'Tail fit tracks steady warm cache region');

  // Group key strips [自动压缩] and thinking tier suffixes
  assert.equal(getStepModelGroupKey({ modelLabel: 'Gemini 3.1 Pro (High) [自动压缩]' }), 'Gemini 3.1 Pro');
  assert.equal(getStepModelGroupKey({ modelLabel: 'Orchestrator (Carbon)' }), 'Orchestrator (Carbon)');

  const chrono = toChronologicalSteps(
    [
      { stepIndex: 3, createdAtMs: 3000 },
      { stepIndex: 1, createdAtMs: 1000 },
      { stepIndex: 2, createdAtMs: 2000 },
    ],
    true
  );
  assert.deepEqual(
    chrono.map((s) => s.stepIndex),
    [1, 2, 3]
  );

  // 2. Verify backend modelBreakdown enriches avgTtftSec and cacheHitPct for main & subagents
  const h = backendHarness({
    trajectories: {
      'root-fit': {
        trajectory: {
          steps: [
            {
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: '2026-06-01T00:00:00Z',
                finishedGeneratingAt: '2026-06-01T00:00:10Z',
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M37',
                  inputTokens: '1000',
                  cacheReadTokens: '9000',
                  outputTokens: '500',
                  thinkingOutputTokens: '100',
                  responseOutputTokens: '400',
                },
              },
              plannerResponse: { response: 'main step 1' },
            },
            {
              type: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: { createdAt: '2026-06-01T00:00:12Z' },
              invokeSubagent: {
                subagents: [{ typeName: 'research', role: 'Fast Researcher' }],
                results: [{ conversationId: 'sub-fit' }],
              },
            },
          ],
          generatorMetadata: [
            { stepIndices: [0], chatModel: { timeToFirstToken: '2.4s', streamingDuration: '7.6s' } },
          ],
        },
      },
      'sub-fit': {
        trajectory: {
          metadata: { parentConversationId: 'root-fit', subagentSpec: { typeName: 'research' } },
          steps: [
            {
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: '2026-06-01T00:00:15Z',
                finishedGeneratingAt: '2026-06-01T00:00:20Z',
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M18',
                  inputTokens: '2000',
                  cacheReadTokens: '6000',
                  outputTokens: '400',
                  thinkingOutputTokens: '50',
                  responseOutputTokens: '350',
                },
              },
              plannerResponse: { response: 'sub step 1' },
            },
          ],
          generatorMetadata: [
            { stepIndices: [0], chatModel: { timeToFirstToken: '0.8s', streamingDuration: '4.2s' } },
          ],
        },
      },
    },
    summaries: {
      'root-fit': { stepCount: 2, lastModifiedTime: '2026-06-01T00:00:12Z', status: 'IDLE' },
      'sub-fit': {
        stepCount: 1,
        lastModifiedTime: '2026-06-01T00:00:20Z',
        status: 'IDLE',
        trajectoryMetadata: { parentConversationId: 'root-fit' },
      },
    },
  });

  const payload = await h.buildTelemetryPayloadInternal('root-fit');
  const mainMb = payload.activeConversation.modelBreakdown;
  assert.equal(mainMb.length, 1);
  assert.equal(mainMb[0].avgTtftSec, 2.4);
  assert.equal(mainMb[0].ttftSampleCount, 1);
  assert.equal(mainMb[0].cacheHitPct, 90);

  const subMb = payload.activeConversation.agents[1].modelBreakdown;
  assert.equal(subMb.length, 1);
  assert.equal(subMb[0].avgTtftSec, 0.8);
  assert.equal(subMb[0].cacheHitPct, 75);

  const aggMb = payload.activeConversation.aggregated.modelBreakdown;
  assert.equal(aggMb.length, 2);
});

test('saving preferences sends the same legacy values normalized by the backend', async (t) => {
  const { saveSettingsPatch, stopAsyncTelemetryLoop, telemetryStore } =
    await import('../src/store/telemetryStore.js');
  const h = backendHarness({ settings: { themeAccent: 'blue' } });
  let savedSettings = JSON.parse(JSON.stringify(h.loadSettings()));
  const previousTelemetry = telemetryStore.getState().telemetry;
  t.after(() => {
    stopAsyncTelemetryLoop();
    telemetryStore.setState({ telemetry: previousTelemetry });
  });
  telemetryStore.setState({ telemetry: { settings: savedSettings } });

  const patches = [];
  let failSave = false;
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    if (options.method === 'POST') {
      assert.equal(path, '/api/settings');
      const patch = JSON.parse(options.body);
      patches.push(patch);
      for (const [key, value] of Object.entries(patch)) {
        assert.deepEqual(telemetryStore.getState().telemetry.settings[key], value);
      }
      if (failSave) {
        return { ok: false, json: async () => ({ error: 'Failed to persist settings' }) };
      }
      const result = h.executeSettingsAction(patch);
      savedSettings = JSON.parse(result.body);
      return { ok: result.ok, json: async () => savedSettings };
    }
    assert.match(path, /^\/api\/telemetry\?/);
    return { ok: true, json: async () => ({ settings: savedSettings }) };
  });

  await saveSettingsPatch({
    windowMountMode: 'sidebar_only',
    topbarCapsuleSlots: ['step_cost', 'cost', 'none'],
    overviewMetrics: ['cost', 'tps'],
    weeklyLimitMode: 'tokens',
  });
  assert.deepEqual(patches[0], {
    windowMountMode: 'sidebar',
    enableWindowOverlay: false,
    topbarCapsuleSlots: ['cost'],
    overviewMetrics: ['step_cost', 'tps'],
    weeklyLimitMode: 'custom_tokens',
  });
  assert.deepEqual(telemetryStore.getState().telemetry.settings, savedSettings);
  assert.equal(savedSettings.themeAccent, 'blue');

  await saveSettingsPatch({ topbarCapsuleSlots: [], weeklyLimitMode: 'cost' });
  assert.deepEqual(patches[1], {
    topbarCapsuleSlots: ['context'],
    weeklyLimitMode: 'custom_cost',
  });

  const telemetryBeforeFailure = telemetryStore.getState().telemetry;
  failSave = true;
  await assert.rejects(saveSettingsPatch({ windowMountMode: 'composer' }), /Failed to persist/);
  assert.equal(telemetryStore.getState().telemetry, telemetryBeforeFailure);
});

test('preferences schema defaults match pre-refactor UI, migrate legacy none slots, and support reset & cache rebuild', async () => {
  // 1. Default schema matches v1.5.3 out-of-box UI (language='auto', modernUi=true)
  const hDefault = backendHarness({});
  const def = hDefault.loadSettings();
  assert.equal(def.language, 'auto');
  assert.equal(def.themeAccent, 'host');
  assert.equal(def.fontScale, 'md');
  assert.equal(def.modernUi, true);
  assert.equal(def.experimentalModernUi, true);

  // Upgrading from v1.5.2 settings.json (with experimentalModernUi: false and no modernUi key) enables modernUi=true
  const hFrom152 = backendHarness({ settings: { language: 'zh-CN', experimentalModernUi: false } });
  const loadedFrom152 = hFrom152.loadSettings();
  assert.equal(loadedFrom152.modernUi, true);
  assert.equal(loadedFrom152.experimentalModernUi, true);
  const optOutRes = hFrom152.executeSettingsAction({ modernUi: false });
  assert.equal(optOutRes.ok, true);
  assert.equal(optOutRes.updated.modernUi, false);
  assert.equal(hFrom152.loadSettings().modernUi, false);
  assert.equal(def.pluginUpdateMode, 'manual');
  assert.equal(def.windowMountMode, 'dual');
  assert.equal(def.enableWindowOverlay, true);
  assert.equal(def.showTopbarMultiSession, true);
  assert.equal(def.contextAgentMode, 'main');
  assert.equal(def.enableCliStatusLine, true);
  assert.deepEqual([...def.topbarCapsuleSlots], ['tps', 'ttft', 'context']);
  assert.deepEqual([...def.hoverModules], ['metrics', 'context', 'quotas']);
  assert.deepEqual([...def.overviewModules], ['metrics', 'context', 'quotas', 'live_tasks']);
  assert.deepEqual([...def.overviewMetrics], ['tps', 'ttft', 'avg_tps', 'step_cost']);
  assert.equal(def.showStepTurnRail, false);
  assert.equal(def.showStepAgentBadge, true);
  assert.equal(def.showStepSpeedColor, false);
  assert.equal(def.showStepFilterToolbar, false);
  assert.deepEqual([...def.stepTableColumns], ['step', 'model', 'tps', 'ttft', 'tokens_combo', 'cache', 'cost']);
  assert.deepEqual({ ...def.modelContextWindows }, {});

  // 2. Legacy 3-slot ['context', 'none', 'quota_auto'] migrates cleanly to 2-item ['context', 'quota_auto']
  assert.deepEqual(
    [...hDefault.normalizeTopbarCapsuleSlots(['context', 'none', 'quota_auto'])],
    ['context', 'quota_auto']
  );
  // Up to 5 unique items supported, duplicates stripped, empty falls back to ['context']
  assert.deepEqual(
    [...hDefault.normalizeTopbarCapsuleSlots(['tps', 'ttft', 'cost', 'cache_hit', 'session_tokens', 'gemini_5h'])],
    ['tps', 'ttft', 'cost', 'cache_hit', 'session_tokens']
  );
  assert.deepEqual([...hDefault.normalizeTopbarCapsuleSlots(['none', 'none', 'none'])], ['context']);

  // 3. Hover modules allow 0 items (explicit []), overviewModules & overviewMetrics require >= 1, stepTableColumns require >= 2
  assert.deepEqual([...hDefault.normalizeHoverModules([])], []);
  assert.deepEqual([...hDefault.normalizeOverviewModules([])], ['metrics']);
  assert.deepEqual([...hDefault.normalizeOverviewMetrics([])], ['tps']);
  assert.deepEqual([...hDefault.normalizeStepTableColumns(['cost'])], ['cost', 'step']);
  assert.equal(hDefault.normalizeContextAgentMode('auto'), 'auto');
  assert.equal(hDefault.normalizeContextAgentMode('main'), 'main');
  assert.equal(hDefault.normalizeContextAgentMode('unknown'), 'main');

  // 4. Updating preferences must not apply legacy global limits or bulk model updates
  const saveRes = hDefault.executeSettingsAction({
    language: 'en-US',
    themeAccent: 'emerald',
    fontScale: 'lg',
    contextAgentMode: 'auto',
    topbarCapsuleSlots: ['context', 'tps', 'ttft', 'cost'],
    hoverModules: ['metrics', 'context'],
    overviewModules: ['quotas', 'metrics'],
    overviewMetrics: ['avg_tps', 'cache_hit'],
    enableCliStatusLine: false,
    showStepTurnRail: true,
    showStepAgentBadge: false,
    showStepSpeedColor: true,
    showStepFilterToolbar: true,
    stepTableColumns: ['step', 'time', 'model', 'duration', 'input_tokens', 'output_tokens', 'cost'],
    contextLimitOverrideTokens: 128000,
    modelContextWindows: { MODEL_PLACEHOLDER_M418: '900K' },
  });
  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.updated.language, 'en-US');
  assert.equal(saveRes.updated.themeAccent, 'emerald');
  assert.equal(saveRes.updated.fontScale, 'lg');
  assert.equal(saveRes.updated.contextAgentMode, 'auto');
  assert.equal(saveRes.updated.topbarCapsuleSlots.length, 4);
  assert.deepEqual([...saveRes.updated.hoverModules], ['metrics', 'context']);
  assert.deepEqual([...saveRes.updated.overviewModules], ['quotas', 'metrics']);
  assert.deepEqual([...saveRes.updated.overviewMetrics], ['avg_tps', 'cache_hit']);
  assert.equal(saveRes.updated.enableCliStatusLine, false);
  assert.equal(saveRes.updated.showStepTurnRail, true);
  assert.equal(saveRes.updated.showStepAgentBadge, false);
  assert.equal(saveRes.updated.showStepSpeedColor, true);
  assert.equal(saveRes.updated.showStepFilterToolbar, true);
  assert.equal(saveRes.updated.contextLimitOverrideTokens, undefined);
  assert.deepEqual({ ...saveRes.updated.modelContextWindows }, {});

  const hWithSteps = backendHarness({
    settings: {
      contextLimitOverrideTokens: 128000,
      modelContextWindows: { MODEL_PLACEHOLDER_M418: '900K' },
    },
    cache: { c1: old },
    trajectories: { c1: raw },
    summaries: { c1: { stepCount: 1, lastModifiedTime: '2026-01-01T00:00:10Z', status: 'IDLE' } },
  });
  const telemetry = await hWithSteps.buildTelemetryPayloadInternal('c1');
  assert.equal(telemetry.activeConversation.context.compactionLimitTokens, 256000);
  assert.equal(telemetry.activeConversation.context.limitTokens, 256000);

  // 5. executeRebuildCacheAction clears trajectoryCache & writes empty cache object
  const rebuildRes = hWithSteps.executeRebuildCacheAction();
  assert.equal(rebuildRes.ok, true);
  const lastCacheSave = hWithSteps.state.saves[hWithSteps.state.saves.length - 1];
  assert.deepEqual(JSON.parse(JSON.stringify(lastCacheSave.data)), {});

  // 6. executeResetSettingsAction restores full defaults cleanly
  const resetRes = hDefault.executeResetSettingsAction();
  assert.equal(resetRes.ok, true);
  assert.equal(resetRes.updated.language, 'auto');
  assert.equal(resetRes.updated.modernUi, true);
  assert.equal(resetRes.updated.themeAccent, 'host');
  assert.equal(resetRes.updated.contextAgentMode, 'main');
  assert.equal(resetRes.updated.enableCliStatusLine, true);
  assert.equal(resetRes.updated.showStepTurnRail, false);
  assert.equal(resetRes.updated.showStepAgentBadge, true);
  assert.equal(resetRes.updated.showStepSpeedColor, false);
  assert.equal(resetRes.updated.showStepFilterToolbar, false);
  assert.deepEqual([...resetRes.updated.topbarCapsuleSlots], ['tps', 'ttft', 'context']);
});

test('assigns unified rootTurnIndex across interleaved main and subagent steps so multi-agent turn rail never fragments', async () => {
  const mkPlanner = (stepIndex, createdAt, finishedGeneratingAt) => ({
    status: 'CORTEX_STEP_STATUS_DONE',
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex },
      createdAt,
      finishedGeneratingAt,
      modelUsage: { model: 'MODEL_PLACEHOLDER_M429', inputTokens: '100', cacheReadTokens: '0', outputTokens: '80' },
    },
    plannerResponse: { response: 'ok' },
  });

  const h = backendHarness({
    trajectories: {
      'root-turn': {
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: '第一轮设计' } },
            mkPlanner(1, '2026-11-13T20:00:01Z', '2026-11-13T20:00:03Z'),
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: '确认。设计是满意的。执行' } },
            mkPlanner(3, '2026-11-13T20:33:10Z', '2026-11-13T20:33:12Z'),
            mkPlanner(5, '2026-11-13T20:33:30Z', '2026-11-13T20:33:35Z'),
          ],
        },
      },
      'sub-turn': {
        trajectory: {
          metadata: { parentConversationId: 'root-turn', rootConversationId: 'root-turn' },
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'Subagent internal brief' } },
            mkPlanner(1, '2026-11-13T20:33:20Z', '2026-11-13T20:33:25Z'),
            mkPlanner(2, '2026-11-13T20:33:40Z', '2026-11-13T20:33:45Z'),
          ],
        },
      },
    },
    summaries: {
      'root-turn': { stepCount: 5, lastModifiedTime: '2026-11-13T20:33:35Z', status: 'IDLE' },
      'sub-turn': {
        stepCount: 3,
        lastModifiedTime: '2026-11-13T20:33:45Z',
        status: 'IDLE',
        trajectoryMetadata: { parentConversationId: 'root-turn', rootConversationId: 'root-turn' },
      },
    },
  });

  const p = await h.buildTelemetryPayloadInternal('root-turn');
  const mainSteps = p.activeConversation.recentSteps; // desc: #5 (20:33:30), #3 (20:33:10), #1 (20:00:01)
  const subSteps = p.activeConversation.agents[1].recentSteps; // desc: #2 (20:33:40), #1 (20:33:20)

  for (const s of [mainSteps[0], mainSteps[1], subSteps[0], subSteps[1]]) {
    assert.equal(s.rootTurnIndex, 2);
    assert.equal(s.isRootLatestTurn, true);
    assert.equal(s.rootTurnPrompt, '确认。设计是满意的。执行');
  }
  assert.equal(mainSteps[1].isRootTurnStart, true);
  assert.equal(mainSteps[0].isRootTurnStart, false);
  assert.equal(subSteps[1].isRootTurnStart, false);
  assert.equal(subSteps[1].isTurnStart, true);
  assert.equal(subSteps[1].turnPrompt, 'Subagent internal brief');

  const panel = JSON.parse((await h.executeTelemetryAction({
    conversationId: 'root-turn', stepDetails: 'display'
  })).body).activeConversation;
  const full = JSON.parse((await h.executeTelemetryAction({
    conversationId: 'root-turn'
  })).body).activeConversation;
  assert.equal(panel.recentSteps.length, full.recentSteps.length);
  assert.equal(panel.agents.length, full.agents.length);
  for (const [displaySteps, fullSteps] of [
    [panel.recentSteps, full.recentSteps],
    [panel.agents[1].recentSteps, full.agents[1].recentSteps],
  ]) {
    assert.equal(displaySteps.length, fullSteps.length);
    for (let i = 0; i < fullSteps.length; i++) {
      assert.equal(displaySteps[i].rootTurnPrompt, fullSteps[i].rootTurnPrompt);
      assert.equal(displaySteps[i].tokPerSec, fullSteps[i].tokPerSec);
      assert.equal(displaySteps[i].contextTokens, fullSteps[i].contextTokens);
      assert.ok(!Object.hasOwn(displaySteps[i], 'contextBreakdown'));
      assert.ok(Object.hasOwn(fullSteps[i], 'contextBreakdown'));
    }
  }
  const requested = { conversationId: 'root-turn', stepDetails: 'display' };
  const initial = JSON.parse((await h.executeTelemetryAction({ ...requested, stepRevision: '' })).body);
  const delta = JSON.parse((await h.executeTelemetryAction({
    ...requested, stepRevision: initial.stepRevision,
  })).body);
  assert.equal(delta.stepsUnchanged, true);
  assert.equal(delta.activeConversation.recentSteps, undefined);
  assert.equal(delta.activeConversation.agents[1].recentSteps, undefined);
  assert.equal(delta.activeConversation.agents[1].stepCount, 2);
});

test('reconciles 8-group context breakdown with real API prompt+output tokens and auto-refreshes cached dropped groups', async () => {
  const stepIndex = 2504;
  const createdAt = '2026-11-15T07:55:00Z';
  const finishedAt = '2026-11-15T07:55:56Z';
  const raw311b = {
    trajectory: {
      steps: [
        {
          status: 'CORTEX_STEP_STATUS_DONE',
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          metadata: {
            sourceTrajectoryStepInfo: { stepIndex },
            createdAt,
            finishedGeneratingAt: finishedAt,
            modelUsage: {
              model: 'MODEL_PLACEHOLDER_M427',
              inputTokens: '4989',
              cacheReadTokens: '150223',
              outputTokens: '3116',
              thinkingOutputTokens: '1573',
              responseOutputTokens: '1543',
            },
          },
          plannerResponse: { response: 'final answer', thinkingDuration: '12s' },
        },
      ],
      generatorMetadata: [
        {
          stepIndices: [stepIndex],
          chatModel: {
            responseModel: 'gemini-4-carbon',
            timeToFirstToken: '12.1s',
            streamingDuration: '44.6s',
            chatStartMetadata: {
              contextWindowMetadata: {
                estimatedTokensUsed: 148852,
                maxContextTokens: 256000,
                tokenBreakdown: {
                  totalTokens: 148852,
                  groups: [
                    { type: 'TOKEN_TYPE_SYSTEM_PROMPT', name: 'System Prompt', numTokens: 5505 },
                    { type: 'TOKEN_TYPE_MCP_TOOLS', name: 'Mcp Tools', numTokens: 234 },
                    { type: 'TOKEN_TYPE_SUBAGENTS', name: 'Subagents', numTokens: 1741 },
                    { type: 'TOKEN_TYPE_SKILLS', name: 'Skills', numTokens: 2201 },
                    { type: 'TOKEN_TYPE_PLUGINS', name: 'Plugins', numTokens: 1601 },
                    { type: 'TOKEN_TYPE_RULES', name: 'Rules', numTokens: 2282 },
                    { type: 'TOKEN_TYPE_TOOLS', name: 'Tools', numTokens: 8857 },
                    {
                      type: 'TOKEN_TYPE_CHAT_MESSAGES',
                      name: 'Chat Messages',
                      numTokens: 126431,
                      children: [
                        { name: '2449: CHECKPOINT', numTokens: 5087 },
                        { name: '2450: USER_INPUT', numTokens: 281 },
                        { name: '2455: SYSTEM_MESSAGE', numTokens: 179 },
                        { name: '2502: PLANNER_RESPONSE', numTokens: 15017 },
                        { name: '2503: GENERIC', numTokens: 105867 },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    },
  };

  // Simulate legacy cached entry where SKILLS/RULES/SUBAGENTS/PLUGINS were dropped (141027 < 148852)
  const staleCacheEntry = {
    signature: `v13-clean:2505:${finishedAt}`,
    title: '用量图表与调用记录优化建议',
    lastModifiedMs: Date.parse(finishedAt),
    contextLimitTelemetry: true,
    speedClearedTelemetry: true,
    turnRailTelemetry: true,
    subagentRefs: [],
    steps: [
      {
        stepIndex,
        isCompactionStep: false,
        modelKey: 'MODEL_PLACEHOLDER_M427',
        modelSource: 'usage.model',
        responseModel: 'gemini-4-carbon',
        modelIdentityVersion: 5,
        createdAt,
        createdAtMs: Date.parse(createdAt),
        inputTokens: 4989,
        cacheReadTokens: 150223,
        outputTokens: 3116,
        thinkingTokens: 1573,
        responseTokens: 1543,
        estimatedContextTokens: 148852,
        maxContextBudgetTokens: 256000,
        reportedContextLimitTokens: 256000,
        turnIndex: 1,
        isTurnStart: true,
        contextBreakdown: {
          messagesTokens: 126431,
          userInputTokens: 281,
          assistantTokens: 15017,
          toolResultsTokens: 105867,
          subagentTokens: 179,
          checkpointTokens: 5087,
          systemToolsTokens: 8857,
          mcpToolsTokens: 234,
          skillsTokens: 0,
          systemPromptTokens: 5505,
          userRulesTokens: 0,
          totalTokens: 141027,
        },
      },
    ],
  };

  const h = backendHarness({
    cache: { c311b: staleCacheEntry },
    trajectories: { c311b: raw311b },
    summaries: {
      c311b: {
        stepCount: 2505,
        lastModifiedTime: finishedAt,
        status: 'IDLE',
        annotations: { title: '用量图表与调用记录优化建议' },
      },
    },
  });

  const payload = await h.buildTelemetryPayloadInternal('c311b');
  const ctx = payload.activeConversation.context;
  const step0 = payload.activeConversation.recentSteps[0];

  // Context window total matches step table contextTokens (155,212 prompt + 3,116 output = 158,328)
  assert.equal(step0.contextTokens, 158328);
  assert.equal(ctx.totalTokens, 158328);
  assert.equal(ctx.usedPct, 61.8);
  assert.equal(payload.conversations[0].contextUsedPct, 61.8);
  assert.equal(payload.activeConversation.inputTokens, 4989);
  assert.equal(payload.activeConversation.cacheReadTokens, 150223);
  assert.equal(payload.activeConversation.outputTokens, 3116);
  assert.equal(payload.activeConversation.totalTokens, 158328);
  assert.equal(payload.activeConversation.latestPromptTokens, 155212);

  // Previously dropped Skills & User Rules are restored and scaled cleanly
  assert.ok(ctx.skillsTokens >= 2290 && ctx.skillsTokens <= 2300, `skills=${ctx.skillsTokens}`);
  assert.ok(ctx.userRulesTokens >= 2375 && ctx.userRulesTokens <= 2385, `rules=${ctx.userRulesTokens}`);
  assert.ok(ctx.systemPromptTokens >= 9220 && ctx.systemPromptTokens <= 9230, `sys=${ctx.systemPromptTokens}`);

  // All 10 breakdown channels sum exact-to-the-token to ctx.totalTokens (158,328)
  const channelSum =
    ctx.userInputTokens +
    ctx.assistantTokens +
    ctx.toolResultsTokens +
    ctx.subagentTokens +
    ctx.checkpointTokens +
    ctx.systemToolsTokens +
    ctx.mcpToolsTokens +
    ctx.skillsTokens +
    ctx.systemPromptTokens +
    ctx.userRulesTokens;
  assert.equal(channelSum, 158328);
  assert.equal(
    ctx.messagesTokens,
    ctx.userInputTokens +
      ctx.assistantTokens +
      ctx.toolResultsTokens +
      ctx.subagentTokens +
      ctx.checkpointTokens
  );

  // Subsequent poll does not re-fetch now that contextGroupsTelemetry is persisted
  const fetchCountAfterFirst = h.state.calls.filter((c) => c.method === 'GetCascadeTrajectory').length;
  assert.equal(fetchCountAfterFirst, 1);
  await h.buildTelemetryPayloadInternal('c311b');
  const fetchCountAfterSecond = h.state.calls.filter((c) => c.method === 'GetCascadeTrajectory').length;
  assert.equal(fetchCountAfterSecond, 1);
});

test('antigravity-cli multi-dir transcript fallback recovers offline sessions and upgrades once LS comes online', async () => {
  const cliId = '88888888-4444-4444-8888-111111111111';
  const h = backendHarness({
    summaries: {},
    trajectories: {
      [cliId]: new Error('Language Server offline'),
    },
    diskDirs: {
      '/test-home/.gemini/antigravity-cli/brain': [cliId],
    },
    deepStats: {
      titleMap: {},
      perConvo: {
        [`cli:${cliId}`]: {
          appSource: 'cli',
          entries: [
            {
              ts: '2026-11-15T12:00:02Z',
              model: 'claude-sonnet-4-6',
              modelCanonicalId: 'claude-sonnet-4-6',
              modelDisplayName: 'Claude Sonnet 4.6',
              provider: 'API_PROVIDER_ANTHROPIC_VERTEX',
              inp: 4000,
              cache: 16000,
              out: 300,
              reasoning: 100,
            },
          ],
        },
      },
    },
    transcripts: {
      [cliId]: [
        {
          step_index: 1,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-15T12:00:00Z',
          content: '<USER_REQUEST>\n排查无头 Linux CLI 远程监控配置\n</USER_REQUEST>',
        },
        {
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-15T12:00:02Z',
          input_tokens: 4000,
          cache_read_tokens: 16000,
          output_tokens: 400,
          content: '已完成排查。',
        },
      ],
    },
  });

  // 1. Offline mode: recovers CLI conversation list, prompt-derived title, turn rail, and token accounting
  const offlinePayload = await h.buildTelemetryPayloadInternal(cliId);
  assert.equal(offlinePayload.conversations.length, 1);
  assert.equal(offlinePayload.conversations[0].cascadeId, cliId);
  assert.equal(offlinePayload.conversations[0].title, '排查无头 Linux CLI 远程监控配置');
  assert.equal(offlinePayload.activeConversation.inputTokens, 4000);
  assert.equal(offlinePayload.activeConversation.cacheReadTokens, 16000);
  assert.equal(offlinePayload.activeConversation.outputTokens, 400);
  const offlineStep = offlinePayload.activeConversation.recentSteps[0];
  assert.equal(offlineStep.turnIndex, 1);
  assert.equal(offlineStep.turnPrompt, '排查无头 Linux CLI 远程监控配置');
  assert.equal(offlineStep.tokPerSec, null);
  assert.equal(offlineStep.selectedSpeedReason, 'incomplete_or_invalid_timing');
  assert.equal(
    offlinePayload.consumption.sourcesBreakdown.some(
      (s) => s.name === 'Antigravity CLI' && s.totalTokens === 20400
    ),
    true
  );

  // Steady offline poll does not hammer GetCascadeTrajectory
  const callsAfterFirst = h.state.calls.filter((c) => c.method === 'GetCascadeTrajectory').length;
  assert.equal(callsAfterFirst, 1);
  await h.buildTelemetryPayloadInternal(cliId);
  const callsAfterSecond = h.state.calls.filter((c) => c.method === 'GetCascadeTrajectory').length;
  assert.equal(callsAfterSecond, 1);

  // 2. Language Server comes online: immediately upgrades offline fallback entry to full RPC telemetry
  h.state.summaries = {
    [cliId]: {
      stepCount: 2,
      lastModifiedTime: '2026-11-15T12:00:06Z',
      status: 'IDLE',
      annotations: { title: 'CLI 在线完整轨迹' },
    },
  };
  h.state.trajectories[cliId] = {
    numTotalSteps: 2,
    trajectory: {
      steps: [
        {
          type: 'CORTEX_STEP_TYPE_USER_INPUT',
          userInput: { userResponse: '排查无头 Linux CLI 远程监控配置' },
        },
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          plannerResponse: { response: '已完成排查。', thinkingTokens: 100, responseTokens: 300 },
          metadata: {
            createdAt: '2026-11-15T12:00:02Z',
            finishedGeneratingAt: '2026-11-15T12:00:06Z',
            sourceTrajectoryStepInfo: { stepIndex: 1 },
            modelUsage: {
              model: 'MODEL_CLAUDE_4_SONNET',
              responseModel: 'claude-sonnet-4-6',
              apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX',
              inputTokens: 4000,
              cacheReadTokens: 16000,
              outputTokens: 400,
            },
          },
        },
      ],
      generatorMetadata: [
        {
          stepIndices: [1],
          chatModel: {
            timeToFirstToken: '0.8s',
            modelDisplayName: 'Claude Sonnet 4.6',
          },
        },
      ],
    },
  };

  const onlinePayload = await h.buildTelemetryPayloadInternal(cliId);
  const onlineStep = onlinePayload.activeConversation.recentSteps[0];
  assert.equal(onlinePayload.activeConversation.title, 'CLI 在线完整轨迹');
  assert.equal(onlineStep.tokPerSec, 100);
  assert.equal(onlineStep.ttftSec, 0.8);
});

test('standalonePort setting normalizes valid ports and notifies auto-host listener on change and reset', () => {
  const h = backendHarness();
  const observedPorts = [];
  h.setStandalonePortListener((p) => observedPorts.push(p));

  assert.equal(h.normalizeStandalonePort(0), 0);
  assert.equal(h.normalizeStandalonePort(80), 0);
  assert.equal(h.normalizeStandalonePort(70000), 0);
  assert.equal(h.normalizeStandalonePort('8787'), 8787);

  const saved = h.executeSettingsAction({ standalonePort: 8787 });
  assert.equal(saved.ok, true);
  assert.equal(saved.updated.standalonePort, 8787);
  assert.deepEqual(observedPorts, [8787]);

  // Same port does not re-trigger listener
  h.executeSettingsAction({ standalonePort: 8787 });
  assert.deepEqual(observedPorts, [8787]);

  // Reset returns standalonePort to 0 and notifies listener
  const reset = h.executeResetSettingsAction();
  assert.equal(reset.ok, true);
  assert.equal(reset.updated.standalonePort, 0);
  assert.deepEqual(observedPorts, [8787, 0]);
});

function encodeProtoVarint(value) {
  let v = BigInt(value);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function encodeProtoFieldVarint(fieldNo, value) {
  return Buffer.concat([encodeProtoVarint((fieldNo << 3) | 0), encodeProtoVarint(value)]);
}

function encodeProtoFieldBytes(fieldNo, payload) {
  const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([
    encodeProtoVarint((fieldNo << 3) | 2),
    encodeProtoVarint(buf.length),
    buf,
  ]);
}

test('Antigravity CLI annotations.pbtxt + SQLite trajectory reader recovers title, TPS, TTFT, thinking split, and 10-channel context', () => {
  assert.equal(
    parseAnnotationPbtxtTitle('last_user_view_time:{seconds:1794759792}\ntitle:"Greeting and Hello"\n'),
    'Greeting and Hello'
  );
  assert.equal(
    parseAnnotationPbtxtTitle('title: "用量图表与调用记录优化建议"'),
    '用量图表与调用记录优化建议'
  );
  // Octal UTF-8 byte escape for "你好" (\344\275\240\345\245\275) + escaped quote
  assert.equal(
    parseAnnotationPbtxtTitle('title:"\\344\\275\\240\\345\\245\\275 \\"CLI\\""'),
    '你好 "CLI"'
  );

  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) return;

  const tempRoot = mkdtempSync(fileURLToPath(new URL('./.cli-sqlite-', import.meta.url)));
  try {
    const cliRoot = join(tempRoot, 'antigravity-cli');
    const convDir = join(cliRoot, 'conversations');
    const annDir = join(cliRoot, 'annotations');
    const cid = '278a0174-296c-45a9-bc6c-62ce7bdd82c4';
    const logDir = join(cliRoot, 'brain', cid, '.system_generated', 'logs');
    mkdirSync(convDir, { recursive: true });
    mkdirSync(annDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    writeFileSync(
      join(annDir, `${cid}.pbtxt`),
      'last_user_view_time:{seconds:1794759792 nanos:730218300}\ntitle:"Greeting and Hello"\n',
      'utf8'
    );
    assert.equal(readAnnotationTitleForCascade(cid, [annDir]), 'Greeting and Hello');

    // Create conversation_summaries.db matching Antigravity CLI 1.5.9 schema
    const sumDb = new DatabaseSync(join(cliRoot, 'conversation_summaries.db'));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT NOT NULL,
        title TEXT,
        status TEXT,
        parent_conversation_id TEXT,
        agent_name TEXT,
        not_fully_idle INTEGER,
        killed INTEGER,
        step_count INTEGER,
        last_modified_time TEXT,
        app_data_dir TEXT
      );
    `);
    sumDb
      .prepare(
        `INSERT INTO conversation_summaries
         (conversation_id, title, status, parent_conversation_id, agent_name, not_fully_idle, killed, step_count, last_modified_time, app_data_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cid,
        'Greeting and Hello',
        'CASCADE_RUN_STATUS_IDLE',
        '',
        '',
        0,
        0,
        2,
        '2026-11-15 16:23:12.7302183+00:00',
        'antigravity-cli'
      );
    sumDb.close();

    const summaryMap = readLocalSummaryIndex([cliRoot]);
    assert.equal(summaryMap.get(cid)?.title, 'Greeting and Hello');
    assert.equal(summaryMap.get(cid)?.status, 'CASCADE_RUN_STATUS_IDLE');

    // Create conversations/<cid>.db with protobuf metadata matching Antigravity CLI 1.5.9
    const modelUsageBuf = Buffer.concat([
      encodeProtoFieldVarint(1, 1526), // MODEL_PLACEHOLDER_M526
      encodeProtoFieldVarint(2, 14569), // inputTokens
      encodeProtoFieldVarint(3, 89), // outputTokens
      encodeProtoFieldVarint(6, 24), // API_PROVIDER_GOOGLE_GEMINI
      encodeProtoFieldVarint(9, 57), // thinkingOutputTokens
      encodeProtoFieldVarint(10, 32), // responseOutputTokens
    ]);
    const stepMetaBuf = Buffer.concat([
      encodeProtoFieldBytes(
        1,
        Buffer.concat([encodeProtoFieldVarint(1, 1794759788), encodeProtoFieldVarint(2, 899044700)])
      ),
      encodeProtoFieldBytes(
        6,
        Buffer.concat([encodeProtoFieldVarint(1, 1794759792), encodeProtoFieldVarint(2, 175393200)])
      ),
      encodeProtoFieldBytes(
        7,
        Buffer.concat([encodeProtoFieldVarint(1, 1794759792), encodeProtoFieldVarint(2, 730218300)])
      ),
      encodeProtoFieldBytes(9, modelUsageBuf),
      encodeProtoFieldBytes(20, encodeProtoFieldVarint(2, 1)),
    ]);

    const encodeGroup = (name, typeInt, numTokens, children = []) =>
      Buffer.concat([
        encodeProtoFieldBytes(1, name),
        encodeProtoFieldVarint(2, typeInt),
        encodeProtoFieldVarint(4, numTokens),
        ...children.map((c) => encodeProtoFieldBytes(5, c)),
      ]);
    const tokenBreakdownBuf = Buffer.concat([
      encodeProtoFieldBytes(1, encodeGroup('System Prompt', 1, 6244)),
      encodeProtoFieldBytes(1, encodeGroup('Mcp Tools', 4, 234)),
      encodeProtoFieldBytes(1, encodeGroup('Subagents', 6, 689)),
      encodeProtoFieldBytes(1, encodeGroup('Skills', 5, 4102)),
      encodeProtoFieldBytes(1, encodeGroup('Rules', 3, 2282)),
      encodeProtoFieldBytes(1, encodeGroup('Tools', 2, 6972)),
      encodeProtoFieldBytes(
        1,
        encodeGroup('Chat Messages', 7, 149, [encodeGroup('0: USER_INPUT', 0, 149)])
      ),
    ]);
    const contextWindowBuf = Buffer.concat([
      encodeProtoFieldVarint(1, 20672),
      encodeProtoFieldBytes(3, tokenBreakdownBuf),
      encodeProtoFieldVarint(4, 256000),
    ]);
    const chatModelBuf = Buffer.concat([
      encodeProtoFieldBytes(1, 'x'.repeat(8192)), // large prompt skipped in O(1)
      encodeProtoFieldVarint(3, 1526),
      encodeProtoFieldBytes(4, modelUsageBuf),
      encodeProtoFieldBytes(9, encodeProtoFieldBytes(10, contextWindowBuf)),
      encodeProtoFieldBytes(
        11,
        Buffer.concat([encodeProtoFieldVarint(1, 3), encodeProtoFieldVarint(2, 276645700)])
      ),
      encodeProtoFieldBytes(12, encodeProtoFieldVarint(2, 555832700)),
      encodeProtoFieldBytes(19, 'gemini-4-hydrogen'),
      encodeProtoFieldBytes(
        20,
        Buffer.concat([
          encodeProtoFieldBytes(1, 'model_enum'),
          encodeProtoFieldBytes(2, 'MODEL_PLACEHOLDER_M526'),
        ])
      ),
      encodeProtoFieldBytes(21, 'Gemini 4 Hydrogen (Medium)'),
    ]);
    const genMetaBuf = Buffer.concat([
      encodeProtoFieldBytes(2, Buffer.from([1])),
      encodeProtoFieldBytes(1, chatModelBuf),
    ]);

    const convDbPath = join(convDir, `${cid}.db`);
    const convDb = new DatabaseSync(convDbPath);
    convDb.exec(`
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    convDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(0, 14, 3, null);
    convDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(1, 15, 3, stepMetaBuf);
    convDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, genMetaBuf);
    convDb.close();

    writeFileSync(
      join(logDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-15T16:23:08Z',
          content: '<USER_REQUEST>\n你好\n</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-15T16:23:08Z',
          model: 'gemini-4-hydrogen-medium',
          input_tokens: 14569,
          cache_read_tokens: 0,
          output_tokens: 89,
          content: '你好呀！今天有什么我可以帮你的吗？',
        }),
      ].join('\n'),
      'utf8'
    );

    const decoded = readLocalSqliteTrajectory(convDbPath);
    assert.ok(decoded);
    assert.equal(decoded.steps.length, 2);
    assert.equal(decoded.generatorMetadata.length, 1);
    assert.equal(decoded.generatorMetadata[0].chatModel.modelDisplayName, 'Gemini 4 Hydrogen (Medium)');

    // End-to-end verification in isolated child process with ANTIGRAVITY_GEMINI_DIR
    const builderUrl = new URL('../backend/telemetry-builder.mjs', import.meta.url).href;
    const rawOut = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { buildTelemetryPayload } = await import(${JSON.stringify(builderUrl)});
         const p = await buildTelemetryPayload(${JSON.stringify(cid)}, false, { range: 'all' });
         process.stdout.write(JSON.stringify({
           title: p.activeConversation?.title,
           modelLabel: p.activeConversation?.activeModelLabel,
           tokPerSec: p.activeConversation?.latestTokPerSec,
           ttftSec: p.activeConversation?.latestTtftSec,
           step: p.activeConversation?.recentSteps?.[0],
           ctx: p.activeConversation?.context,
           sources: p.consumption?.sourcesBreakdown,
         }));`,
      ],
      {
        env: {
          ...process.env,
          ANTIGRAVITY_GEMINI_DIR: tempRoot,
          ANTIGRAVITY_APP_DATA_DIR: '',
          USAGE_MONITOR_APP_DATA_DIR: '',
          ANTIGRAVITY_EXECUTABLE_DATA_DIR: '',
          USAGE_MONITOR_DATA_DIR: join(tempRoot, 'data'),
          ANTIGRAVITY_LS_ADDRESS: 'test.invalid',
          ANTIGRAVITY_CSRF_TOKEN: 'test',
        },
        encoding: 'utf8',
      }
    );
    const parsed = JSON.parse(rawOut);
    assert.equal(parsed.title, 'Greeting and Hello');
    assert.equal(parsed.modelLabel, 'Gemini 4 Hydrogen (Medium)');
    assert.equal(parsed.tokPerSec, 23.2);
    assert.ok(Math.abs(parsed.ttftSec - 3.2766) < 0.01);
    assert.equal(parsed.step.thinkingTokens, 57);
    assert.equal(parsed.step.responseTokens, 32);
    assert.equal(parsed.step.turnPrompt, '你好');
    assert.equal(parsed.step.estimatedContextTokens, 20672);
    assert.equal(parsed.step.contextBreakdown.mcpToolsTokens, 234);
    assert.equal(parsed.step.contextBreakdown.skillsTokens, 4102);
    assert.equal(parsed.step.contextBreakdown.userRulesTokens, 2282);
    assert.equal(parsed.step.contextBreakdown.systemToolsTokens, 6972);
    assert.equal(parsed.step.contextBreakdown.userInputTokens, 149);
    assert.equal(parsed.ctx.totalTokens, 14658);
    assert.equal(parsed.ctx.limitTokens, 256000);
    const cliSource = parsed.sources?.find((s) => s.name === 'Antigravity CLI');
    assert.ok(cliSource);
    assert.equal(cliSource.calls, 1);
    assert.equal(cliSource.totalTokens, 14658);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('provisions Antigravity CLI statusLine safely and renders live capsule from stdin + SQLite + quota snapshot', async (t) => {
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) {
    t.skip('node:sqlite is unavailable in this Node runtime');
    return;
  }

  const h = backendHarness();
  assert.equal(
    h.buildCliStatusLineCommand('C:\\Users\\Administrator\\.gemini\\config\\plugins\\usage-monitor\\sidecars\\panel\\cli-statusline.mjs', {
      platform: 'win32',
      nodeOnPath: true,
    }),
    'node C:/Users/Administrator/.gemini/config/plugins/usage-monitor/sidecars/panel/cli-statusline.mjs'
  );
  const winSpaceCmd = h.buildCliStatusLineCommand(
    'C:\\Users\\Alice Smith\\.gemini\\config\\plugins\\usage-monitor\\sidecars\\panel\\cli-statusline.mjs',
    {
      platform: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      nodeOnPath: false,
    }
  );
  assert.equal(
    winSpaceCmd,
    "node --input-type=module -e import('file:///C:/Users/Alice%20Smith/.gemini/config/plugins/usage-monitor/sidecars/panel/cli-statusline.mjs#autorun')"
  );
  assert.equal(winSpaceCmd.includes('"'), false, 'Windows command must contain zero double quotes so Go syscall.EscapeArg never injects \\"');
  assert.equal(h.isManagedCliStatusLineCommand('node C:/path/to/cli-statusline.mjs'), true);
  assert.equal(h.isManagedCliStatusLineCommand(winSpaceCmd), true);
  assert.equal(h.isManagedCliStatusLineCommand('node "C:/legacy/path/cli-statusline.mjs"'), true);
  assert.equal(h.isManagedCliStatusLineCommand('python C:/custom/my-status.py'), false);

  // Never overwrites user's third-party statusLine command
  const customPreserved = h.applyCliStatusLineToSettingsObject(
    { theme: 'dark', statusLine: { type: 'command', command: 'python ~/my-status.py', enabled: true } },
    { enabled: true, command: 'node "/plugin/cli-statusline.mjs"' }
  );
  assert.equal(customPreserved.changed, false);
  assert.equal(customPreserved.preservedCustom, true);

  // Migrates legacy managed stack_with_default: true to single-line inline stack_with_default: false
  const migratedStack = h.applyCliStatusLineToSettingsObject(
    {
      statusLine: {
        type: 'command',
        command: 'node C:/plugin/cli-statusline.mjs',
        enabled: true,
        padding: 0,
        stack_with_default: true,
      },
    },
    { enabled: true, command: 'node C:/plugin/cli-statusline.mjs' }
  );
  assert.equal(migratedStack.changed, true);
  assert.equal(migratedStack.object.statusLine.stack_with_default, false);

  assert.deepEqual({ ...h.parseCliModelAndEffort('Gemini 4 Hydrogen (Medium)', 'medium') }, {
    modelName: 'Gemini 4 Hydrogen',
    effort: 'medium',
  });
  assert.deepEqual({ ...h.parseCliModelAndEffort('Gemini 4 Hydrogen (High)', '') }, {
    modelName: 'Gemini 4 Hydrogen',
    effort: 'high',
  });

  // Capsule formatting: NO_COLOR renders compact plain text; 24-bit ANSI renders inline pill gauges (48;2;...m) with zero OSC
  const plainCapsule = h.formatCliStatusLineCapsule(
    {
      hasTelemetry: true,
      runningCount: 0,
      runningSubCount: 0,
      ttft: 11.8,
      tps: 38.1,
      usedPct: 17,
      quotas: { activePool: { remainingPct: 57 } },
    },
    {
      slots: ['ttft', 'tps', 'quota_auto', 'context'],
      showMultiSession: true,
      language: 'zh-CN',
      color: false,
    }
  );
  assert.equal(plainCapsule, '● 0 运行中   11.8s | 38.1 t/s | 余 57% | 上下文 17%');

  const ansiCapsule = h.formatCliStatusLineCapsule(
    {
      hasTelemetry: true,
      runningCount: 2,
      runningSubCount: 1,
      ttft: 1.25,
      tps: 68.4,
      usedPct: 75,
      quotas: { activePool: { remainingPct: 22 } },
    },
    {
      slots: ['ttft', 'tps', 'quota_auto', 'context'],
      showMultiSession: true,
      language: 'zh-CN',
      color: true,
    }
  );
  assert.equal(/\x1b\[48;2;116;84;22m/.test(ansiCapsule), true, 'Emits warm amber 24-bit pill fill for warn quota/context');
  assert.equal(/\x1b\[48;2;36;40;50m/.test(ansiCapsule), true, 'Emits dark slate unfilled pill track');
  assert.equal(/\x1b\]/.test(ansiCapsule), false, 'Contains zero OSC sequences so Bubble Tea width never breaks');
  assert.equal(
    ansiCapsule.replace(/\x1b\[[0-9;]*m/g, ''),
    '● 2 运行中 · 1 子   1.3s | 68.4 t/s |  余 22%  |  上下文 75% '
  );

  // Full 3-column single-line bar with left shortcuts, centered pill metrics, and right mode/model/effort
  const inlineBar120 = h.formatCliStatusLineCapsule(
    {
      hasTelemetry: true,
      runningCount: 2,
      runningSubCount: 0,
      ttft: 5.6,
      tps: 22.0,
      usedPct: 2,
      quotas: { activePool: { remainingPct: 54 } },
    },
    {
      slots: ['ttft', 'tps', 'quota_auto', 'context'],
      showMultiSession: true,
      language: 'zh-CN',
      color: true,
      terminalWidth: 120,
      cycleMode: 'auto',
      modelDisplayName: 'Gemini 4 Hydrogen (Medium)',
      modelEffort: 'medium',
    }
  );
  assert.equal(/\x1b\[48;2;24;96;68m/.test(inlineBar120), true, 'Quota normal pill uses deep emerald fill');
  assert.equal(/\x1b\[48;2;36;72;128m/.test(inlineBar120), true, 'Context normal pill uses slate-blue fill');
  const plainBar120 = inlineBar120.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(plainBar120.startsWith('? for shortcuts  '), 'Keeps ? for shortcuts on the left');
  assert.ok(
    plainBar120.includes('● 2 运行中   5.6s | 22.0 t/s |  余 54%  |  上下文  2% '),
    'Keeps compact pill gauges with right-aligned percentage and full chrome in 120 columns'
  );
  assert.ok(plainBar120.endsWith('  auto · Gemini 4 Hydrogen · medium'), 'Renders deduplicated mode · model · effort on the right');
  assert.equal(h.cliDisplayWidth(inlineBar120), 119, 'Fits cleanly within terminalWidth - 1 without wrapping');

  // Compact 108-column terminal still fits full 3-column chrome AND pill gauges cleanly (saves ~12 cols over Braille bars)
  const inlineBar108 = h.formatCliStatusLineCapsule(
    {
      hasTelemetry: true,
      runningCount: 2,
      runningSubCount: 0,
      ttft: 5.6,
      tps: 22.0,
      usedPct: 2,
      quotas: { activePool: { remainingPct: 54 } },
    },
    {
      slots: ['ttft', 'tps', 'quota_auto', 'context'],
      showMultiSession: true,
      language: 'zh-CN',
      color: true,
      terminalWidth: 108,
      cycleMode: 'auto',
      modelDisplayName: 'Gemini 4 Hydrogen (Medium)',
      modelEffort: 'medium',
    }
  );
  const plainBar108 = inlineBar108.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(plainBar108.startsWith('? for shortcuts  '), 'Keeps ? for shortcuts at 108 columns');
  assert.ok(
    plainBar108.includes('● 2 运行中   5.6s | 22.0 t/s |  余 54%  |  上下文  2% '),
    'Fits compact pill gauges and full chrome even at 108 columns'
  );
  assert.ok(plainBar108.endsWith('  auto · Gemini 4 Hydrogen · medium'), 'Keeps full right chrome at 108 columns');
  assert.equal(h.cliDisplayWidth(inlineBar108), 107, '108-col bar fits cleanly within terminalWidth - 1');

  // Narrow 80-column terminal gracefully compacts without wrapping
  const inlineBar80 = h.formatCliStatusLineCapsule(
    {
      hasTelemetry: true,
      runningCount: 2,
      runningSubCount: 0,
      ttft: 5.6,
      tps: 22.0,
      usedPct: 2,
      quotas: { activePool: { remainingPct: 54 } },
    },
    {
      slots: ['ttft', 'tps', 'quota_auto', 'context'],
      showMultiSession: true,
      language: 'zh-CN',
      color: false,
      terminalWidth: 80,
      cycleMode: 'auto',
      modelDisplayName: 'Gemini 4 Hydrogen (Medium)',
      modelEffort: 'medium',
    }
  );
  assert.ok(h.cliDisplayWidth(inlineBar80) <= 79, 'Narrow 80-col bar never overflows terminalWidth - 1');
  assert.ok(inlineBar80.includes('5.6s | 22.0 t/s | 余 54% | 上下文 2%'));

  // End-to-end filesystem + subprocess verification
  const tempRoot = mkdtempSync(fileURLToPath(new URL('./.cli-statusline-', import.meta.url)));
  try {
    const cliDir = join(tempRoot, 'antigravity-cli');
    const convDir = join(cliDir, 'conversations');
    const dataDir = join(tempRoot, 'data');
    mkdirSync(convDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const cliSettingsFile = join(cliDir, 'settings.json');
    writeFileSync(
      cliSettingsFile,
      JSON.stringify({ selectedAuthType: 'oauth', model: 'gemini-3.1-pro-high' }, null, 2),
      'utf8'
    );

    const statusLineScript = fileURLToPath(new URL('../cli-statusline.mjs', import.meta.url));
    const installEnv = {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: tempRoot,
      ANTIGRAVITY_APP_DATA_DIR: '',
      USAGE_MONITOR_APP_DATA_DIR: '',
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: '',
      USAGE_MONITOR_DATA_DIR: dataDir,
      USAGE_MONITOR_ALLOW_TEST_CLI_SETTINGS: '1',
    };

    const installOut = JSON.parse(
      execFileSync(process.execPath, [statusLineScript, '--install'], {
        env: installEnv,
        encoding: 'utf8',
      }).trim()
    );
    assert.equal(installOut.updated, true);
    const writtenSettings = JSON.parse(readFileSync(cliSettingsFile, 'utf8'));
    assert.equal(writtenSettings.selectedAuthType, 'oauth', 'Existing CLI settings preserved');
    assert.equal(writtenSettings.statusLine.type, 'command');
    assert.equal(writtenSettings.statusLine.enabled, true);
    assert.equal(writtenSettings.statusLine.stack_with_default, false);
    assert.ok(writtenSettings.statusLine.command.includes('cli-statusline.mjs'));

    // Prepare real SQLite conversation + summaries + quota snapshot + custom user slot order
    const cid = '22222222-3333-4444-5555-666666666666';
    const sumDb = new DatabaseSync(join(cliDir, 'conversation_summaries.db'));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT NOT NULL,
        title TEXT,
        status TEXT,
        parent_conversation_id TEXT,
        agent_name TEXT,
        not_fully_idle INTEGER,
        killed INTEGER,
        step_count INTEGER,
        last_modified_time TEXT,
        app_data_dir TEXT
      );
      CREATE TABLE conversations_fts (conversation_id TEXT, title TEXT, workspace TEXT, last_modified_time INTEGER, chunk_index INTEGER);
    `);
    sumDb
      .prepare(
        `INSERT INTO conversation_summaries
         (conversation_id, title, status, parent_conversation_id, agent_name, not_fully_idle, killed, step_count, last_modified_time, app_data_dir)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(cid, 'CLI Capsule E2E', 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, 2, '2026-11-15 17:00:15+00:00', 'antigravity-cli');
    sumDb
      .prepare('INSERT INTO conversations_fts (conversation_id, title, workspace, last_modified_time, chunk_index) VALUES (?, ?, ?, ?, ?)')
      .run(cid, 'CLI Capsule E2E', 'C:/Work/MyProject', 1794762015, -1);
    sumDb.close();

    // 10.0s request (1794762001.0s -> 1794762011.0s), 381 outputTokens => 38.1 tok/s, TTFT = 1.8s
    const modelUsageBuf = Buffer.concat([
      encodeProtoFieldVarint(1, 1425), // MODEL_PLACEHOLDER_M425
      encodeProtoFieldVarint(2, 1200), // inputTokens
      encodeProtoFieldVarint(3, 381), // outputTokens
      encodeProtoFieldVarint(5, 13800), // cacheReadTokens
      encodeProtoFieldVarint(6, 24), // API_PROVIDER_GOOGLE_GEMINI
    ]);
    const stepMetaBuf = Buffer.concat([
      encodeProtoFieldBytes(1, encodeProtoFieldVarint(1, 1794762001)), // createdAt
      encodeProtoFieldBytes(6, encodeProtoFieldVarint(1, 1794762011)), // finishedGeneratingAt (+10.0s)
      encodeProtoFieldBytes(7, encodeProtoFieldVarint(1, 1794762011)), // completedAt
      encodeProtoFieldBytes(9, modelUsageBuf),
      encodeProtoFieldBytes(20, encodeProtoFieldVarint(2, 1)), // stepIndex = 1
    ]);
    const chatModelBuf = Buffer.concat([
      encodeProtoFieldVarint(3, 1425),
      encodeProtoFieldBytes(4, modelUsageBuf),
      encodeProtoFieldBytes(
        11,
        Buffer.concat([encodeProtoFieldVarint(1, 1), encodeProtoFieldVarint(2, 800000000)]) // TTFT = 1.8s
      ),
      encodeProtoFieldBytes(12, encodeProtoFieldVarint(1, 10)), // streamingDuration = 10s
    ]);
    const genMetaBuf = Buffer.concat([
      encodeProtoFieldBytes(2, Buffer.from([1])),
      encodeProtoFieldBytes(1, chatModelBuf),
    ]);

    const convDb = new DatabaseSync(join(convDir, `${cid}.db`));
    convDb.exec(`
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    convDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(0, 14, 3, null);
    convDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(1, 15, 3, stepMetaBuf);
    convDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, genMetaBuf);
    convDb.close();

    writeFileSync(
      join(dataDir, 'settings.json'),
      JSON.stringify({
        language: 'zh-CN',
        showTopbarMultiSession: true,
        enableCliStatusLine: true,
        topbarCapsuleSlots: ['ttft', 'tps', 'quota_auto', 'context'],
      }),
      'utf8'
    );
    writeFileSync(
      join(dataDir, 'cli-status-snapshot.json'),
      JSON.stringify({
        updatedAtMs: Date.now(),
        runningCount: 0,
        runningSubCount: 0,
        hasWaiting: false,
        quotas: {
          activePool: { poolLabel: 'Gemini', remainingPct: 57 },
          pools: [{ poolKey: 'Gemini', poolLabel: 'Gemini', remainingPct: 57 }],
        },
      }),
      'utf8'
    );

    const stdinPayload = JSON.stringify({
      agent_state: 'idle',
      cwd: 'C:\\Work\\MyProject',
      context_window: { used_percentage: 17, total_input_tokens: 15000, total_output_tokens: 381 },
      cost: { total_usd: 0.012 },
    });

    const capsuleOut = execFileSync(process.execPath, [statusLineScript], {
      env: { ...installEnv, NO_COLOR: '1' },
      input: stdinPayload,
      encoding: 'utf8',
    }).trim();
    assert.equal(capsuleOut, '● 0 运行中   1.8s | 38.1 t/s | 余 57% | 上下文 17%');

    // Full 3-column single-line E2E with terminal_width + cycle_mode + model + native stdin quota fallback
    const emptySnapDir = join(tempRoot, 'empty-data');
    mkdirSync(emptySnapDir, { recursive: true });
    writeFileSync(
      join(emptySnapDir, 'settings.json'),
      JSON.stringify({
        language: 'zh-CN',
        showTopbarMultiSession: true,
        enableCliStatusLine: true,
        topbarCapsuleSlots: ['ttft', 'tps', 'quota_auto', 'context'],
      }),
      'utf8'
    );
    const fullLineStdin = JSON.stringify({
      agent_state: 'running',
      cwd: 'C:\\Work\\MyProject',
      terminal_width: 130,
      cycle_mode: 'auto',
      model: {
        id: 'gemini-4-hydrogen-medium',
        display_name: 'Gemini 4 Hydrogen (Medium)',
        effort: 'medium',
      },
      quota: {
        Gemini: { remaining_fraction: 0.54 },
      },
      context_window: { used_percentage: 2, total_input_tokens: 15000, total_output_tokens: 381 },
    });
    const fullLineOut = execFileSync(process.execPath, [statusLineScript], {
      env: { ...installEnv, USAGE_MONITOR_DATA_DIR: emptySnapDir },
      input: fullLineStdin,
      encoding: 'utf8',
    }).replace(/\r?\n$/, '');
    assert.equal(/\x1b\[48;2;/.test(fullLineOut), true, 'E2E ANSI output renders 24-bit pill background fill');
    const plainFullLine = fullLineOut.replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(plainFullLine.startsWith('? for shortcuts  '));
    assert.ok(plainFullLine.includes('● 1 运行中   1.8s | 38.1 t/s |  余 54%  |  上下文  2% '));
    assert.ok(plainFullLine.endsWith('  auto · Gemini 4 Hydrogen · medium'));
    assert.equal(h.cliDisplayWidth(fullLineOut), 129);

    if (process.platform === 'win32') {
      assert.equal(writtenSettings.statusLine.command.includes('"'), false);
      const cmdCapsuleOut = execFileSync('cmd.exe', ['/c', writtenSettings.statusLine.command], {
        env: { ...installEnv, NO_COLOR: '1' },
        input: stdinPayload,
        encoding: 'utf8',
      }).trim();
      assert.equal(cmdCapsuleOut, '● 0 运行中   1.8s | 38.1 t/s | 余 57% | 上下文 17%');

      const spaceDir = join(tempRoot, 'Dir With Spaces');
      mkdirSync(spaceDir, { recursive: true });
      const spaceCmd = h.buildCliStatusLineCommand(statusLineScript, {
        platform: 'win32',
        nodeOnPath: true,
      });
      assert.ok(spaceCmd);
      const encodedAutorunCmd = `node --input-type=module -e import('${new URL('../cli-statusline.mjs', import.meta.url).href}#autorun')`;
      const autorunOut = execFileSync('cmd.exe', ['/c', encodedAutorunCmd], {
        cwd: spaceDir,
        env: { ...installEnv, NO_COLOR: '1' },
        input: stdinPayload,
        encoding: 'utf8',
      }).trim();
      assert.equal(autorunOut, '● 0 运行中   1.8s | 38.1 t/s | 余 57% | 上下文 17%');
    }

    // Verify compaction-line precedence: when local trajectory reports maxContextTokens (e.g. 512k),
    // statusLine aligns with Desktop App's compaction-limit percentage instead of agy's physical 1M used_percentage.
    const cidLimit = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const limitUsageBuf = Buffer.concat([
      encodeProtoFieldVarint(1, 1535), // MODEL_PLACEHOLDER_M535 (Gemini 4 Neon)
      encodeProtoFieldVarint(2, 10040), // inputTokens
      encodeProtoFieldVarint(3, 1000), // outputTokens
      encodeProtoFieldVarint(5, 460000), // cacheReadTokens => prompt + output = 471,040
      encodeProtoFieldVarint(6, 24), // API_PROVIDER_GOOGLE_GEMINI
    ]);
    const limitStepMetaBuf = Buffer.concat([
      encodeProtoFieldBytes(1, encodeProtoFieldVarint(1, 1794762101)),
      encodeProtoFieldBytes(6, encodeProtoFieldVarint(1, 1794762111)),
      encodeProtoFieldBytes(7, encodeProtoFieldVarint(1, 1794762111)),
      encodeProtoFieldBytes(9, limitUsageBuf),
      encodeProtoFieldBytes(20, encodeProtoFieldVarint(2, 1)),
    ]);
    const ctxWinMetaBuf = Buffer.concat([
      encodeProtoFieldVarint(1, 450000), // estimatedTokensUsed
      encodeProtoFieldVarint(4, 512000), // maxContextTokens (official compaction threshold)
    ]);
    const limitChatModelBuf = Buffer.concat([
      encodeProtoFieldVarint(3, 1535),
      encodeProtoFieldBytes(4, limitUsageBuf),
      encodeProtoFieldBytes(9, encodeProtoFieldBytes(10, ctxWinMetaBuf)), // chatStartMetadata.contextWindowMetadata
      encodeProtoFieldBytes(
        11,
        Buffer.concat([encodeProtoFieldVarint(1, 1), encodeProtoFieldVarint(2, 800000000)])
      ),
      encodeProtoFieldBytes(12, encodeProtoFieldVarint(1, 10)),
    ]);
    const limitGenMetaBuf = Buffer.concat([
      encodeProtoFieldBytes(2, Buffer.from([1])),
      encodeProtoFieldBytes(1, limitChatModelBuf),
    ]);
    const limitConvDb = new DatabaseSync(join(convDir, `${cidLimit}.db`));
    limitConvDb.exec(`
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    limitConvDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(0, 14, 3, null);
    limitConvDb
      .prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)')
      .run(1, 15, 3, limitStepMetaBuf);
    limitConvDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, limitGenMetaBuf);
    limitConvDb.close();

    const limitStdin = JSON.stringify({
      session_id: cidLimit,
      agent_state: 'idle',
      cwd: 'C:\\Work\\MyProject',
      // agy reports physical 1M ratio (~42%), while compaction limit 471,040 / 512,000 = 92.0%
      context_window: { used_percentage: 42, total_input_tokens: 470040, total_output_tokens: 1000 },
    });
    const limitOut = execFileSync(process.execPath, [statusLineScript], {
      env: { ...installEnv, NO_COLOR: '1' },
      input: limitStdin,
      encoding: 'utf8',
    }).trim();
    assert.ok(
      limitOut.includes('上下文 92%'),
      `expected compaction-limit 92% instead of physical 42%, got: ${limitOut}`
    );
    assert.equal(limitOut.includes('42%'), false);
    const limitAnsiOut = execFileSync(process.execPath, [statusLineScript], {
      env: installEnv,
      input: limitStdin,
      encoding: 'utf8',
    }).trim();
    assert.equal(/\x1b\[48;2;124;42;48m/.test(limitAnsiOut), true, '92% compaction limit uses danger crimson pill');
    assert.ok(limitAnsiOut.replace(/\x1b\[[0-9;]*m/g, '').includes(' 上下文 92% '));

    // Verify real non-test.invalid buildTelemetryPayload writes cli-status-snapshot.json cleanly without throwing
    const builderUrl = new URL('../backend/telemetry-builder.mjs', import.meta.url).href;
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { buildTelemetryPayload } = await import(${JSON.stringify(builderUrl)});
         const p = await buildTelemetryPayload(${JSON.stringify(cid)}, false, { range: 'all' });
         if (!p || !p.activeConversation) process.exit(2);`,
      ],
      {
        env: {
          ...installEnv,
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
          ANTIGRAVITY_CSRF_TOKEN: 'live-check',
        },
        encoding: 'utf8',
      }
    );
    const liveWrittenSnap = JSON.parse(readFileSync(join(dataDir, 'cli-status-snapshot.json'), 'utf8'));
    assert.equal(liveWrittenSnap.activeConversation.cascadeId, cid);
    assert.equal(liveWrittenSnap.activeConversation.latestTokPerSec, 38.1);
    assert.ok(Number.isFinite(liveWrittenSnap.updatedAtMs) && liveWrittenSnap.updatedAtMs > 0);

    // Verify uninstall removes managed statusLine while keeping other settings intact
    const uninstallOut = JSON.parse(
      execFileSync(process.execPath, [statusLineScript, '--uninstall'], {
        env: installEnv,
        encoding: 'utf8',
      }).trim()
    );
    assert.equal(uninstallOut.updated, true);
    const afterUninstall = JSON.parse(readFileSync(cliSettingsFile, 'utf8'));
    assert.equal(afterUninstall.selectedAuthType, 'oauth');
    assert.equal(afterUninstall.statusLine, undefined);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('CLI statusLine v1.5.4 upgrades: /statusline inline flags, preserved managed flags, model-aware quota pool, empty-session cleanup, anomaly badge, and narrow-terminal shedding', async () => {
  const h = backendHarness();
  const {
    buildMergedCliCapsuleContext,
    parseCliStatusLineArgs,
  } = await import('../cli-statusline.mjs');

  // 1. Slot presets, comma lists (1-6 slots), and backwards-compatible fallback
  assert.deepEqual(
    [...h.resolveEffectiveCliStatusLineSlots({ topbarCapsuleSlots: ['tps', 'ttft', 'context'], cliStatusLineSlots: null })],
    ['tps', 'ttft', 'session_cost', 'quota_auto', 'context']
  );
  assert.deepEqual(
    [...h.resolveEffectiveCliStatusLineSlots({ topbarCapsuleSlots: ['ttft', 'tps', 'quota_auto', 'context'], cliStatusLineSlots: null })],
    ['ttft', 'tps', 'quota_auto', 'context']
  );
  assert.deepEqual([...h.normalizeCliStatusLineSlots('full')], [
    'tps', 'ttft', 'cache_hit', 'session_cost', 'quota_auto', 'context',
  ]);
  assert.deepEqual([...h.normalizeCliStatusLineSlots('compact')], ['tps', 'ttft', 'context']);
  assert.equal(h.normalizeCliStatusLineSlots('auto'), null);

  // 2. Managed flag extraction & preservation across daemon sync
  assert.equal(
    h.extractManagedCliStatusLineFlags('node C:/plugin/cli-statusline.mjs --slots tps,cache_hit,context --no-multi'),
    '--slots tps,cache_hit,context --no-multi'
  );
  assert.equal(
    h.extractManagedCliStatusLineFlags("node --input-type=module -e import('file:///C:/dir%20a/cli-statusline.mjs#autorun') -- --preset full"),
    '--preset full'
  );
  const preservedFlags = h.applyCliStatusLineToSettingsObject(
    {
      statusLine: {
        type: 'command',
        command: 'node C:/plugin/cli-statusline.mjs --preset full --no-multi',
        enabled: true,
        padding: 0,
        stack_with_default: true,
      },
    },
    { enabled: true, command: 'node C:/plugin/cli-statusline.mjs' }
  );
  assert.equal(preservedFlags.changed, true);
  assert.equal(
    preservedFlags.object.statusLine.command,
    'node C:/plugin/cli-statusline.mjs --preset full --no-multi',
    'User flags appended via /statusline must survive daemon statusLine reconciliation'
  );

  // 3. Inline flag parsing
  const parsedFlags = parseCliStatusLineArgs([
    '--slots', 'tps,cache_hit,context',
    '--no-multi',
    '--no-anomaly',
    '--lang=en-US',
    '--no-color',
  ]);
  assert.equal(parsedFlags.slotsRaw, 'tps,cache_hit,context');
  assert.equal(parsedFlags.showMultiSession, false);
  assert.equal(parsedFlags.showAnomaly, false);
  assert.equal(parsedFlags.language, 'en-US');
  assert.equal(parsedFlags.noColor, true);

  // 4. Model-aware active quota pool & expanded agent_state detection (working / tool_use)
  const mergedClaudeCtx = buildMergedCliCapsuleContext({
    stdinData: {
      agent_state: 'tool_use',
      model: { id: 'claude-opus-4-6-thinking', display_name: 'Claude Opus 4.6 (Thinking)' },
      context_window: { used_percentage: 22 },
    },
    snapshot: {
      updatedAtMs: Date.now(),
      runningCount: 0,
      quotas: {
        activePool: { poolKey: 'Gemini', poolLabel: 'Gemini', remainingPct: 25 },
        pools: [
          { poolKey: 'Gemini', poolLabel: 'Gemini', remainingPct: 25, models: ['Gemini 4 Neon (XHigh)'] },
          { poolKey: 'Claude & GPT', poolLabel: 'Claude & GPT', remainingPct: 100, models: ['Claude Opus 4.6 (Thinking)'] },
        ],
      },
    },
  });
  assert.equal(mergedClaudeCtx.isRunning, true);
  assert.equal(mergedClaudeCtx.runningCount, 1);
  assert.equal(mergedClaudeCtx.quotas.activePool.poolKey, 'Claude & GPT');
  assert.equal(mergedClaudeCtx.quotas.activePool.remainingPct, 100);

  // 5. Fresh session (stepCount: 0) hides empty --s / -- placeholders while keeping status, quota, and context
  const freshBar = h.formatCliStatusLineCapsule(
    {
      hasTelemetry: true,
      stepCount: 0,
      isRunning: false,
      runningCount: 0,
      tps: null,
      ttft: null,
      sessionCost: null,
      usedPct: 16,
      quotas: { activePool: { remainingPct: 98 } },
    },
    {
      slots: ['tps', 'ttft', 'session_cost', 'quota_auto', 'context'],
      language: 'zh-CN',
      color: false,
    }
  );
  assert.equal(freshBar, '● 0 运行中   空闲 | 余 98% | 上下文 16%');

  // 5b. Dedicated 5h / weekly / context slots in NO_COLOR and pill ANSI modes (zh-CN & en-US)
  const quotaBarCtx = {
    hasTelemetry: true,
    stepCount: 3,
    usedPct: 56,
    quotas: {
      pools: [
        { poolKey: 'Gemini', family: 'Gemini', remainingPct: 64, weeklyRemainingPct: 88 },
        { poolKey: 'Claude & GPT', family: 'Claude & GPT', remainingPct: 96, weeklyRemainingPct: 14 },
      ],
    },
  };
  assert.equal(
    h.formatCliStatusLineCapsule(quotaBarCtx, {
      slots: ['gemini_5h', 'gemini_weekly', 'claude_5h', 'claude_weekly', 'context'],
      showMultiSession: false,
      language: 'zh-CN',
      color: false,
    }),
    'G5h 64% | G周 88% | C5h 96% | C周 14% | 上下文 56%'
  );
  const quotaPillAnsi = h.formatCliStatusLineCapsule(quotaBarCtx, {
    slots: ['gemini_5h', 'claude_weekly', 'context'],
    showMultiSession: false,
    language: 'zh-CN',
    color: true,
  });
  assert.equal(/\x1b\[48;2;24;96;68m/.test(quotaPillAnsi), true, '64% quota uses green pill fill');
  assert.equal(/\x1b\[48;2;124;42;48m/.test(quotaPillAnsi), true, '14% quota uses danger red pill fill');
  assert.equal(/\x1b\[48;2;36;72;128m/.test(quotaPillAnsi), true, '56% context uses blue pill fill');
  assert.equal(
    quotaPillAnsi.replace(/\x1b\[[0-9;]*m/g, ''),
    ' G5h 64%  |  C周 14%  |  上下文 56% '
  );
  assert.equal(
    h.formatCliStatusLineCapsule(quotaBarCtx, {
      slots: ['gemini_weekly', 'claude_weekly', 'context'],
      showMultiSession: false,
      language: 'en-US',
      color: false,
    }),
    'Gw 88% | Cw 14% | Ctx 56%'
  );

  // 5c. Local SQLite WAITING step immediately turns CLI dot amber even while Desktop snapshot is still false
  const waitingFromLocalDb = buildMergedCliCapsuleContext({
    stdinData: { agent_state: 'running' },
    localMetrics: {
      found: true,
      cascadeId: '11111111-1111-1111-1111-111111111111',
      dbMtimeMs: Date.now(),
      targetIsRunning: true,
      targetIsWaiting: true,
      targetWaitingApprovalFresh: true,
      runningRootCount: 1,
      stepCount: 5,
    },
    snapshot: {
      updatedAtMs: Date.now() - 1000,
      runningCount: 1,
      hasWaiting: false,
      waitingCascadeIds: [],
    },
  });
  assert.equal(waitingFromLocalDb.runningCount, 1);
  assert.equal(waitingFromLocalDb.hasWaiting, true);
  const amberDotLine = h.formatCliStatusLineCapsule(waitingFromLocalDb, {
    slots: ['tps', 'context'],
    language: 'zh-CN',
    color: true,
  });
  assert.ok(amberDotLine.includes('\x1b[38;2;251;191;36m● '), 'Waiting session dot must render amber SGR');

  // Once local DB resumes (newer than stale Desktop snapshot), dot returns to green immediately
  const resumedFromLocalDb = buildMergedCliCapsuleContext({
    stdinData: { agent_state: 'running' },
    localMetrics: {
      found: true,
      cascadeId: '11111111-1111-1111-1111-111111111111',
      dbMtimeMs: Date.now(),
      targetIsRunning: true,
      targetIsWaiting: false,
      targetWaitingApprovalFresh: false,
      runningRootCount: 1,
      stepCount: 6,
    },
    snapshot: {
      updatedAtMs: Date.now() - 1500,
      runningCount: 1,
      hasWaiting: true,
      waitingCascadeIds: ['11111111-1111-1111-1111-111111111111'],
    },
  });
  assert.equal(resumedFromLocalDb.hasWaiting, false);

  // 6. Anomaly badge (toggleable via showAnomaly) + pill SGR & zero OSC
  const withAnom = h.formatCliStatusLineCapsule(
    {
      hasTelemetry: true,
      stepCount: 4,
      runningCount: 1,
      tps: 44.2,
      ttft: 2.1,
      usedPct: 35,
      latestAnomaly: { primaryKind: 'capacity', count: 1, severity: 'warn' },
    },
    {
      slots: ['tps', 'ttft', 'context'],
      language: 'zh-CN',
      color: true,
    }
  );
  assert.equal(/\x1b\[48;2;36;72;128m/.test(withAnom), true);
  assert.equal(/\x1b\]/.test(withAnom), false);
  assert.equal(withAnom.replace(/\x1b\[[0-9;]*m/g, ''), '● 1 运行中   44.2 t/s | 2.1s |  上下文 35%  | ! 503');

  const withoutAnom = h.formatCliStatusLineCapsule(
    {
      hasTelemetry: true,
      stepCount: 4,
      runningCount: 1,
      tps: 44.2,
      ttft: 2.1,
      usedPct: 35,
      latestAnomaly: { primaryKind: 'capacity', count: 1, severity: 'warn' },
    },
    {
      slots: ['tps', 'ttft', 'context'],
      language: 'zh-CN',
      showAnomaly: false,
      color: false,
    }
  );
  assert.equal(withoutAnom, '● 1 运行中   44.2 t/s | 2.1s | 上下文 35%');

  // 7. Narrow 72-column terminal progressively sheds lower-priority slots without wrapping
  const narrow72 = h.formatCliStatusLineCapsule(
    {
      hasTelemetry: true,
      stepCount: 6,
      runningCount: 1,
      tps: 48.2,
      ttft: 1.4,
      cacheHitPct: 95,
      sessionCost: 1.25,
      usedPct: 34,
      quotas: { activePool: { remainingPct: 88 } },
    },
    {
      slots: ['tps', 'ttft', 'cache_hit', 'session_cost', 'quota_auto', 'context'],
      language: 'zh-CN',
      color: false,
      terminalWidth: 72,
      cycleMode: 'auto',
      modelDisplayName: 'Gemini 4 Neon (XHigh)',
      modelEffort: 'xhigh',
    }
  );
  assert.ok(h.cliDisplayWidth(narrow72) <= 71, `Expected <= 71 cols, got ${h.cliDisplayWidth(narrow72)}`);
  assert.ok(narrow72.includes('上下文 34%'));
  assert.ok(narrow72.includes('48.2 t/s'));

  // 8. Subprocess E2E: inline flags & --install preserving custom flags
  const tempRoot = mkdtempSync(fileURLToPath(new URL('./.cli-sl-flags-', import.meta.url)));
  try {
    const cliDir = join(tempRoot, 'antigravity-cli');
    const dataDir = join(tempRoot, 'data');
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const statusLineScript = fileURLToPath(new URL('../cli-statusline.mjs', import.meta.url));
    const env = {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: tempRoot,
      USAGE_MONITOR_DATA_DIR: dataDir,
      USAGE_MONITOR_ALLOW_TEST_CLI_SETTINGS: '1',
      NO_COLOR: '1',
    };

    const installCustom = JSON.parse(
      execFileSync(process.execPath, [statusLineScript, '--install', '--preset', 'full', '--no-multi'], {
        env,
        encoding: 'utf8',
      }).trim()
    );
    assert.equal(installCustom.updated, true);
    assert.ok(installCustom.command.includes('--preset full --no-multi'));

    const reinstallBare = JSON.parse(
      execFileSync(process.execPath, [statusLineScript, '--install'], {
        env,
        encoding: 'utf8',
      }).trim()
    );
    assert.equal(reinstallBare.updated, false);
    const savedCliSettings = JSON.parse(readFileSync(join(cliDir, 'settings.json'), 'utf8'));
    assert.ok(savedCliSettings.statusLine.command.includes('--preset full --no-multi'));

    const inlineOut = execFileSync(
      process.execPath,
      [statusLineScript, '--slots', 'tps,quota_auto,context', '--no-multi', '--lang', 'en-US'],
      {
        env,
        input: JSON.stringify({
          agent_state: 'idle',
          context_window: { used_percentage: 19 },
          quota: { Gemini: { remaining_fraction: 0.91 } },
        }),
        encoding: 'utf8',
      }
    ).trim();
    assert.equal(inlineOut, 'Idle | 5h 91% | Ctx 19%');

    // 9. Runtime CLI installation & status detection (strictly gated on antigravity-cli dir) + forceReplaceCustom recovery
    const { ensureCliStatusLineConfigured, getCliStatusLineRuntimeStatus } = await import(
      '../backend/cli-statusline-config.mjs'
    );
    const missingStatus = getCliStatusLineRuntimeStatus({
      env: { ANTIGRAVITY_GEMINI_DIR: join(tempRoot, 'nonexistent-gemini') },
    });
    assert.deepEqual(missingStatus, {
      installed: false,
      configured: false,
      preservedCustom: false,
      managedFlags: '',
    });

    const managedStatus = getCliStatusLineRuntimeStatus({
      env: { ANTIGRAVITY_GEMINI_DIR: tempRoot },
    });
    assert.deepEqual(managedStatus, {
      installed: true,
      configured: true,
      preservedCustom: false,
      managedFlags: '--preset full --no-multi',
    });

    writeFileSync(
      join(cliDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'custom-bar' } }),
      'utf8'
    );
    const customStatus = getCliStatusLineRuntimeStatus({
      env: { ANTIGRAVITY_GEMINI_DIR: tempRoot },
    });
    assert.deepEqual(customStatus, {
      installed: true,
      configured: false,
      preservedCustom: true,
      managedFlags: '',
    });

    const forceRestored = ensureCliStatusLineConfigured({
      enabled: true,
      env,
      forceReplaceCustom: true,
      preserveManagedFlags: false,
    });
    assert.equal(forceRestored.updated, true);
    assert.deepEqual(
      getCliStatusLineRuntimeStatus({ env: { ANTIGRAVITY_GEMINI_DIR: tempRoot } }),
      {
        installed: true,
        configured: true,
        preservedCustom: false,
        managedFlags: '',
      }
    );

    const noCliPayload = await backendHarness().buildTelemetryPayloadInternal('', false, { range: 'today' });
    assert.equal(noCliPayload.cliStatusLine?.installed, false);
    const withCliPayload = await backendHarness({
      diskDirs: { '/test-home/.gemini/antigravity-cli': [] },
    }).buildTelemetryPayloadInternal('', false, { range: 'today' });
    assert.equal(withCliPayload.cliStatusLine?.installed, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('v1.5 feedback settings schema: custom token combo DSL, 3-way model display mode, popover width bounds, and Worker hot-reload IPC', async () => {
  const { Worker } = await import('node:worker_threads');
  const h = backendHarness({
    trajectories: {
      'conv-cost': {
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              metadata: {
                createdAt: '2026-11-16T05:00:00Z',
                completedAt: '2026-11-16T05:00:04Z',
                firstChunkAt: '2026-11-16T05:00:01Z',
                generatorModel: 'MODEL_PLACEHOLDER_M526',
                modelUsage: {
                  model: 'gemini-4-hydrogen-medium',
                  inputTokens: '10000',
                  cacheReadTokens: '40000',
                  outputTokens: '2000',
                  thinkingTokens: '500',
                },
              },
            },
          ],
        },
      },
    },
    summaries: {
      'conv-cost': { summary: 'Cost Breakdown Session', status: 'CASCADE_RUN_STATUS_IDLE' },
    },
  });

  // 1. Custom token combo DSL normalization & aliases
  assert.deepEqual([...h.parseStepTokenComboSegments('context:new:cache')], [
    'context',
    'in',
    'cache',
  ]);
  assert.equal(h.normalizeStepTokenComboFormat('in / out / cache'), 'in:out:cache');
  assert.equal(h.normalizeStepTokenComboFormat('上下文:输入:正文:思考:总计'), 'context:in:reply:think');
  assert.equal(h.normalizeStepTokenComboFormat('invalid:foo'), 'context:in:cache');

  // 2. 3-way model display mode & legacy showUpstreamModel round-trip
  assert.equal(h.normalizeModelDisplayMode('upstream_compact', false), 'upstream_compact');
  assert.equal(h.normalizeModelDisplayMode(undefined, true), 'upstream');
  assert.equal(h.normalizeModelDisplayMode(undefined, false), 'short');

  assert.equal(h.loadSettings().developerModeEnabled, false);
  assert.equal(h.loadSettings().riskyFeaturesEnabled, false);
  assert.equal(h.loadSettings().contextWindowRiskAccepted, false);

  // Without developerModeEnabled + riskyFeaturesEnabled, risk flags stay hard-locked false
  const blockedRiskRes = h.executeSettingsAction({
    contextWindowRiskAccepted: true,
    accountSwitchRiskAccepted: true,
    contextWindowSwarmEnabled: true,
  });
  assert.equal(blockedRiskRes.ok, true);
  assert.equal(blockedRiskRes.updated.contextWindowRiskAccepted, false);
  assert.equal(blockedRiskRes.updated.accountSwitchRiskAccepted, false);
  assert.equal(blockedRiskRes.updated.contextWindowSwarmEnabled, false);

  const compactRes = h.executeSettingsAction({
    modelDisplayMode: 'upstream_compact',
    popoverWidthMode: 'custom',
    popoverWidth: 1500,
    developerModeEnabled: true,
    riskyFeaturesEnabled: true,
    contextWindowRiskAccepted: true,
    stepTokenComboFormat: 'in:out:cache',
    stepTableColumns: ['step', 'model', 'tokens_io_cache', 'tokens_custom', 'cost'],
  });
  assert.equal(compactRes.ok, true);
  assert.equal(compactRes.updated.modelDisplayMode, 'upstream_compact');
  assert.equal(compactRes.updated.showUpstreamModel, true);
  assert.equal(compactRes.updated.popoverWidthMode, 'custom');
  assert.equal(compactRes.updated.popoverWidth, 1080, 'Clamped to MAX_POPOVER_WIDTH 1080');
  assert.equal(compactRes.updated.developerModeEnabled, true);
  assert.equal(compactRes.updated.riskyFeaturesEnabled, true);
  assert.equal(compactRes.updated.contextWindowRiskAccepted, true);
  assert.equal(compactRes.updated.stepTokenComboFormat, 'in:out:cache');
  assert.deepEqual([...compactRes.updated.stepTableColumns], [
    'step',
    'model',
    'tokens_io_cache',
    'tokens_custom',
    'cost',
  ]);

  // Disabling developerModeEnabled cascades riskyFeaturesEnabled & risk acceptance flags back to false
  const relockRes = h.executeSettingsAction({ developerModeEnabled: false });
  assert.equal(relockRes.ok, true);
  assert.equal(relockRes.updated.developerModeEnabled, false);
  assert.equal(relockRes.updated.riskyFeaturesEnabled, false);
  assert.equal(relockRes.updated.contextWindowRiskAccepted, false);
  assert.equal(relockRes.updated.accountSwitchRiskAccepted, false);
  assert.equal(relockRes.updated.contextWindowSwarmEnabled, false);

  // Legacy caller passing { showUpstreamModel: false } cleanly resets modelDisplayMode -> 'short'
  const legacyReset = h.executeSettingsAction({ showUpstreamModel: false, popoverWidth: 320 });
  assert.equal(legacyReset.updated.modelDisplayMode, 'short');
  assert.equal(legacyReset.updated.showUpstreamModel, false);
  assert.equal(legacyReset.updated.popoverWidth, 440, 'Clamped to MIN_POPOVER_WIDTH 440');

  // 3. Display projection retains inCostUsd / outCostUsd / cacheCostUsd for Sub2-style tooltips
  const dispOut = await h.executeTelemetryAction({
    conversationId: 'conv-cost',
    stepDetails: 'display',
  });
  const dispPayload = JSON.parse(dispOut.body);
  const step0 = dispPayload.activeConversation.recentSteps[0];
  assert.ok(Number.isFinite(step0.inCostUsd) && step0.inCostUsd > 0, 'inCostUsd projected');
  assert.ok(Number.isFinite(step0.cacheCostUsd) && step0.cacheCostUsd > 0, 'cacheCostUsd projected');
  assert.ok(Number.isFinite(step0.outCostUsd) && step0.outCostUsd > 0, 'outCostUsd projected');

  // 4. Real Worker isolate (`sidecar-worker.mjs`) handles API IPC & graceful shutdown without parent exit
  const workerTemp = mkdtempSync(fileURLToPath(new URL('./.worker-test-', import.meta.url)));
  const workerUrl = new URL('../backend/sidecar-worker.mjs', import.meta.url);
  const worker = new Worker(workerUrl, {
    env: {
      ...process.env,
      USAGE_MONITOR_DATA_DIR: workerTemp,
      ANTIGRAVITY_GEMINI_DIR: workerTemp,
      ANTIGRAVITY_APP_DATA_DIR: '',
      USAGE_MONITOR_APP_DATA_DIR: '',
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: '',
      ANTIGRAVITY_LS_ADDRESS: 'test.invalid',
    },
  });
  try {
    const callWorker = (payload) =>
      new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        const onMsg = (msg) => {
          if (msg?.id !== id) return;
          worker.off('message', onMsg);
          resolve(msg);
        };
        worker.on('message', onMsg);
        worker.once('error', reject);
        worker.postMessage({ ...payload, id });
      });

    const saveMsg = await callWorker({
      type: 'api',
      pathname: '/api/settings',
      method: 'POST',
      data: { modelDisplayMode: 'upstream_compact', stepTokenComboFormat: 'context:new:cache' },
    });
    assert.equal(saveMsg.ok, true);
    assert.equal(saveMsg.response.status, 200);
    const savedBody = JSON.parse(saveMsg.response.body);
    assert.equal(savedBody.modelDisplayMode, 'upstream_compact');
    assert.equal(savedBody.stepTokenComboFormat, 'context:in:cache');

    const rebuildMsg = await callWorker({
      type: 'api',
      pathname: '/api/cache/rebuild',
      method: 'POST',
    });
    assert.equal(rebuildMsg.ok, true);
    assert.equal(rebuildMsg.response.status, 200);

    const ackMsg = await callWorker({ type: 'shutdown' });
    assert.equal(ackMsg.type, 'shutdown_ack');
  } finally {
    await worker.terminate().catch(() => {});
    rmSync(workerTemp, { recursive: true, force: true });
  }
});

test('scope=consumption and scope=consumption-presets bypass matchesConv, >30s idle, and visual settings, match full aggregation, and invalidate on weeklyLimitMode/cache rebuild', async (t) => {
  let clockMs = Date.parse('2026-11-19T12:00:00.000Z');
  const mkStep = (idx, offsetMs, tok) => ({
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      ...(offsetMs !== null
        ? {
            createdAt: new Date(clockMs - offsetMs).toISOString(),
            completedAt: new Date(clockMs - offsetMs + 1200).toISOString(),
          }
        : {}),
      sourceTrajectoryStepInfo: { stepIndex: idx },
      modelUsage: {
        model: 'MODEL_CLAUDE_4_5_SONNET',
        inputTokens: String(tok),
        cacheReadTokens: '0',
        outputTokens: '0',
      },
    },
    plannerResponse: { response: `step-${idx}` },
  });

  const h = backendHarness({
    clock: () => clockMs,
    trajectories: {
      'conv-old': {
        trajectory: {
          steps: [
            mkStep(1, 20 * 86400_000, 1000),
            mkStep(2, null, 250),
          ],
        },
      },
      'conv-recent': {
        trajectory: {
          steps: [
            mkStep(1, 4 * 86400_000, 3000),
            mkStep(2, 2 * 3600_000, 500),
          ],
        },
      },
    },
    summaries: {
      'conv-old': {
        stepCount: 2,
        lastModifiedTime: new Date(clockMs - 20 * 86400_000).toISOString(),
        status: 'CASCADE_RUN_STATUS_IDLE',
      },
      'conv-recent': {
        stepCount: 2,
        lastModifiedTime: new Date(clockMs - 2 * 3600_000).toISOString(),
        status: 'CASCADE_RUN_STATUS_RUNNING',
      },
    },
  });

  const initBody = JSON.parse(
    (
      await h.executeTelemetryAction({
        conversationId: 'conv-recent',
        range: 'today',
        stepDetails: 'display',
        stepRevision: '',
      })
    ).body
  );
  assert.ok(Number(initBody.consumption?.revision || 0) > 0);
  const rpcCallsAfterInit = h.state.calls.length;

  // Advance clock by 2 minutes and toggle visual-only settings
  clockMs += 120_000;
  h.executeSettingsAction({ themeAccent: 'emerald', fontScale: 'lg' });

  // Query from a DIFFERENT conversationId (simulating sidebar vs overlay mismatch)
  const presetsRes = JSON.parse(
    (
      await h.executeTelemetryAction({
        conversationId: 'conv-different-pane',
        scope: 'consumption-presets',
      })
    ).body
  );
  assert.equal(presetsRes.scope, 'consumption-presets');
  assert.equal(presetsRes.activeConversation, undefined);
  assert.equal(presetsRes.quotas, undefined);
  assert.equal(presetsRes.ranges.today.account.totalTokens, 500);
  assert.equal(presetsRes.ranges['7d'].account.totalTokens, 3500);
  assert.equal(presetsRes.ranges['30d'].account.totalTokens, 4500);
  assert.equal(presetsRes.ranges.all.account.totalTokens, 4750);

  const liteCustom = JSON.parse(
    (
      await h.executeTelemetryAction({
        conversationId: 'conv-different-pane',
        range: 'custom',
        startMs: String(clockMs - 6 * 86400_000),
        endMs: String(clockMs - 2 * 86400_000),
        scope: 'consumption',
      })
    ).body
  );
  assert.equal(liteCustom.scope, 'consumption');
  assert.equal(liteCustom.activeConversation, undefined);
  assert.equal(liteCustom.consumption.account.totalTokens, 3000);
  assert.equal(
    h.state.calls.length,
    rpcCallsAfterInit,
    'scope=consumption / presets must skip LS RPCs across pane mismatch, >30s idle, and visual settings changes'
  );

  // Changing weeklyLimitMode DOES invalidate snapshot and trigger fresh full build
  h.executeSettingsAction({ weeklyLimitMode: 'custom_tokens' });
  await h.executeTelemetryAction({
    conversationId: 'conv-recent',
    range: '7d',
    scope: 'consumption',
  });
  const rpcCallsAfterWeeklyChange = h.state.calls.length;
  assert.ok(
    rpcCallsAfterWeeklyChange > rpcCallsAfterInit,
    'Changing weeklyLimitMode must invalidate cached fast consumption snapshot'
  );

  // Cache rebuild also invalidates snapshot and falls back to full RPC sync
  h.executeRebuildCacheAction();
  await h.executeTelemetryAction({
    conversationId: 'conv-recent',
    range: 'all',
    scope: 'consumption',
  });
  assert.ok(
    h.state.calls.length > rpcCallsAfterWeeklyChange,
    'Cache rebuild must invalidate cached fast consumption snapshot'
  );

  // Verify frontend selectConsumptionTimeRange sends scope=consumption without force=1
  const {
    clearConsumptionRangeCache,
    selectConsumptionTimeRange,
    stopAsyncTelemetryLoop,
    telemetryStore,
  } = await import('../src/store/telemetryStore.js');
  const prevRange = telemetryStore.getState().selectedTimeRange;
  const requestedUrls = [];
  t.after(() => {
    stopAsyncTelemetryLoop();
    clearConsumptionRangeCache();
    telemetryStore.setState({ selectedTimeRange: prevRange });
  });
  clearConsumptionRangeCache();
  t.mock.method(globalThis, 'fetch', async (url) => {
    requestedUrls.push(String(url));
    return { ok: true, json: async () => liteCustom };
  });
  await selectConsumptionTimeRange('30d');
  assert.equal(requestedUrls.length, 1);
  assert.match(requestedUrls[0], /range=30d/);
  assert.match(requestedUrls[0], /scope=consumption/);
  assert.doesNotMatch(requestedUrls[0], /force=1/);
  assert.doesNotMatch(requestedUrls[0], /fastRange=1/);
});

test('scope=conversation switches sessions with zero LS RPCs, preserves usageRevision, reuses stepRevision/multi-agent cache, and powers 0ms client cache switching', async (t) => {
  const clockMs = Date.parse('2026-11-19T14:00:00.000Z');
  const mkStep = (idx, offsetMs, model, tok) => ({
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt: new Date(clockMs - offsetMs).toISOString(),
      completedAt: new Date(clockMs - offsetMs + 1000).toISOString(),
      sourceTrajectoryStepInfo: { stepIndex: idx },
      modelUsage: {
        model,
        inputTokens: String(tok),
        cacheReadTokens: '0',
        outputTokens: '120',
      },
    },
    plannerResponse: { response: `step-${idx}` },
  });

  const h = backendHarness({
    clock: () => clockMs,
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini',
          remainingFraction: 0.85,
          resetTime: new Date(clockMs + 3 * 3600_000).toISOString(),
        },
        {
          displayName: 'Claude & GPT',
          remainingFraction: 0.42,
          resetTime: new Date(clockMs + 4 * 3600_000).toISOString(),
        },
      ],
    },
    trajectories: {
      'conv-claude': {
        trajectory: {
          steps: [
            mkStep(1, 30 * 60_000, 'MODEL_CLAUDE_4_5_SONNET', 1200),
            mkStep(2, 20 * 60_000, 'MODEL_CLAUDE_4_5_SONNET', 1800),
          ],
        },
      },
      'conv-gemini': {
        trajectory: {
          steps: [
            mkStep(1, 10 * 60_000, 'MODEL_PLACEHOLDER_M37', 4000),
          ],
        },
      },
      'conv-gemini-sub': {
        trajectory: {
          metadata: {
            parentConversationId: 'conv-gemini',
            rootConversationId: 'conv-gemini',
            subagentSpec: { typeName: 'research', role: 'Helper' },
          },
          steps: [
            mkStep(1, 9 * 60_000, 'MODEL_PLACEHOLDER_M37', 900),
          ],
        },
      },
    },
    summaries: {
      'conv-claude': {
        annotations: { title: 'Claude Session' },
        stepCount: 2,
        lastModifiedTime: new Date(clockMs - 20 * 60_000).toISOString(),
        status: 'CASCADE_RUN_STATUS_IDLE',
      },
      'conv-gemini': {
        annotations: { title: 'Gemini Swarm' },
        stepCount: 1,
        lastModifiedTime: new Date(clockMs - 10 * 60_000).toISOString(),
        status: 'CASCADE_RUN_STATUS_IDLE',
      },
      'conv-gemini-sub': {
        stepCount: 1,
        lastModifiedTime: new Date(clockMs - 9 * 60_000).toISOString(),
        status: 'CASCADE_RUN_STATUS_IDLE',
        trajectoryMetadata: {
          parentConversationId: 'conv-gemini',
          rootConversationId: 'conv-gemini',
          subagentSpec: { typeName: 'research', role: 'Helper' },
        },
      },
    },
  });

  // 1. Initial full telemetry load on conv-gemini (multi-agent root)
  const initRes = JSON.parse(
    (
      await h.executeTelemetryAction({
        conversationId: 'conv-gemini',
        range: 'today',
        stepDetails: 'display',
        stepRevision: '',
      })
    ).body
  );
  assert.equal(initRes.activeConversation.cascadeId, 'conv-gemini');
  assert.equal(initRes.activeConversation.subagentCount, 1);
  assert.equal(initRes.quotas.activePool.family, 'Gemini');
  const initialUsageRev = Number(initRes.consumption.revision);
  const rpcAfterInit = h.state.calls.length;

  // 2. Fast switch to conv-claude via scope=conversation: ZERO LS RPCs!
  const switchClaude = JSON.parse(
    (
      await h.executeTelemetryAction({
        conversationId: 'conv-claude',
        range: 'today',
        stepDetails: 'display',
        stepRevision: '',
        scope: 'conversation',
      })
    ).body
  );
  assert.equal(h.state.calls.length, rpcAfterInit, 'scope=conversation must make 0 LS RPC calls');
  assert.equal(switchClaude.scope, 'conversation');
  assert.equal(switchClaude.activeConversation.cascadeId, 'conv-claude');
  assert.equal(switchClaude.activeConversation.stepCount, 2);
  assert.equal(switchClaude.activeConversation.recentSteps.length, 2);
  assert.equal(switchClaude.quotas.activePool.family, 'Claude & GPT');
  assert.equal(switchClaude.consumption.session.calls, 2);
  assert.equal(switchClaude.needsBackgroundSync, false);
  assert.ok(switchClaude.stepRevision);

  // 3. Fast switch back to conv-gemini with cached stepRevision -> stepsUnchanged=true & 0 RPCs
  const switchBackGemini = JSON.parse(
    (
      await h.executeTelemetryAction({
        conversationId: 'conv-gemini',
        range: 'today',
        stepDetails: 'display',
        stepRevision: initRes.stepRevision,
        scope: 'conversation',
      })
    ).body
  );
  assert.equal(h.state.calls.length, rpcAfterInit);
  assert.equal(switchBackGemini.scope, 'conversation');
  assert.equal(switchBackGemini.stepsUnchanged, true);
  assert.equal(switchBackGemini.activeConversation.recentSteps, undefined);
  assert.equal(switchBackGemini.quotas.activePool.family, 'Gemini');

  // 4. Subsequent full poll on conv-claude keeps usageRevision identical (decoupled from isCurrentConv!)
  const fullClaude = JSON.parse(
    (
      await h.executeTelemetryAction({
        conversationId: 'conv-claude',
        range: 'today',
        stepDetails: 'display',
        stepRevision: switchClaude.stepRevision,
      })
    ).body
  );
  assert.equal(fullClaude.consumption.revision, initialUsageRev);
  assert.equal(fullClaude.stepsUnchanged, true);
  assert.equal(fullClaude.consumption.session.calls, 2);

  // 5. Frontend selectConversation: first switch hits scope=conversation; repeat switch hits 0ms client cache + rehydrates stepsUnchanged
  const {
    clearConsumptionRangeCache,
    clearConversationViewCache,
    selectConversation,
    stopAsyncTelemetryLoop,
    telemetryStore,
  } = await import('../src/store/telemetryStore.js');
  const prevTel = telemetryStore.getState().telemetry;
  const prevSel = telemetryStore.getState().selectedConversationId;
  t.after(() => {
    stopAsyncTelemetryLoop();
    clearConsumptionRangeCache();
    clearConversationViewCache();
    telemetryStore.setState({ selectedConversationId: prevSel, telemetry: prevTel });
  });
  clearConversationViewCache();
  telemetryStore.setState({ selectedConversationId: 'conv-gemini', telemetry: initRes }, { sync: true });

  const fetchedUrls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    fetchedUrls.push(u);
    const parsed = new URL(u, 'http://127.0.0.1');
    const q = Object.fromEntries(parsed.searchParams.entries());
    const out = await h.executeTelemetryAction(q);
    return { ok: true, json: async () => JSON.parse(out.body) };
  });

  // Seed cache by visiting conv-claude first
  await selectConversation('conv-claude');
  assert.equal(fetchedUrls.length, 1);
  assert.match(fetchedUrls[0], /scope=conversation/);
  assert.match(fetchedUrls[0], /conversationId=conv-claude/);
  assert.equal(telemetryStore.getState().telemetry.activeConversation.cascadeId, 'conv-claude');
  assert.equal(telemetryStore.getState().telemetry.quotas.activePool.family, 'Claude & GPT');

  // Visit conv-gemini (cached from initRes? Let's visit once to cache, then toggle back to conv-claude for 0ms hit!)
  await selectConversation('conv-gemini');
  assert.equal(telemetryStore.getState().telemetry.activeConversation.cascadeId, 'conv-gemini');

  // Toggle back to conv-claude: store MUST update synchronously BEFORE fetch resolves!
  let releaseSecondFetch;
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetchedUrls.push(String(url));
    await new Promise((resolve) => {
      releaseSecondFetch = resolve;
    });
    const parsed = new URL(String(url), 'http://127.0.0.1');
    const out = await h.executeTelemetryAction(Object.fromEntries(parsed.searchParams.entries()));
    return { ok: true, json: async () => JSON.parse(out.body) };
  });

  const pendingSwitch = selectConversation('conv-claude');
  assert.equal(
    telemetryStore.getState().telemetry.activeConversation.cascadeId,
    'conv-claude',
    'Repeat conversation switch must update activeConversation synchronously in 0ms from client LRU cache'
  );
  assert.equal(telemetryStore.getState().telemetry.activeConversation.recentSteps.length, 2);
  assert.match(fetchedUrls[fetchedUrls.length - 1], new RegExp(`stepRevision=${switchClaude.stepRevision}`));
  releaseSecondFetch();
  await pendingSwitch;
  assert.equal(telemetryStore.getState().telemetry.activeConversation.recentSteps.length, 2);
});

test('CLI statusLine supports --style pill|bar|compact switching, flag persistence, and --json snapshot output', async () => {
  const {
    buildCliJsonStatusOutput,
    formatCliStatusLineCapsule,
    normalizeCliStatusLineGaugeStyle,
  } = await import('../backend/cli-statusline-config.mjs');
  const {
    parseCliStatusLineArgs,
    buildPersistableStatusLineFlags,
  } = await import('../cli-statusline.mjs');

  assert.equal(normalizeCliStatusLineGaugeStyle('bar'), 'bar');
  assert.equal(normalizeCliStatusLineGaugeStyle('compact'), 'compact');
  assert.equal(normalizeCliStatusLineGaugeStyle('unknown'), 'pill');

  const parsedArgs = parseCliStatusLineArgs([
    '--slots',
    'tps,context,gemini_5h',
    '--style',
    'bar',
    '--json',
    '--no-multi',
  ]);
  assert.equal(parsedArgs.style, 'bar');
  assert.equal(parsedArgs.json, true);
  assert.equal(parsedArgs.showMultiSession, false);
  assert.match(buildPersistableStatusLineFlags(parsedArgs), /--style bar/);

  const nowMs = Date.UTC(2026, 10, 22, 12, 0, 0);
  const slotCtx = {
    hasTelemetry: true,
    isRunning: false,
    hasWaiting: false,
    runningCount: 1,
    runningSubCount: 0,
    stepCount: 5,
    tps: 52.3,
    avgTps: 48.0,
    ttft: 2.1,
    stepCost: 0.04,
    sessionCost: 0.32,
    cacheHitPct: 88.5,
    latestPromptTokens: 80_000,
    sessionTokens: 320_000,
    usedPct: 42,
    quotas: {
      activePool: { poolKey: 'Gemini', remainingPct: 40, weeklyRemainingPct: 80 },
      pools: [
        {
          poolKey: 'Gemini',
          family: 'Gemini',
          usedPct: 60,
          remainingPct: 40,
          resetTime: new Date(nowMs + 3 * 3_600_000).toISOString(),
          weeklyUsedPct: 20,
          weeklyRemainingPct: 80,
          weeklyResetTime: new Date(nowMs + 3.5 * 24 * 3_600_000).toISOString(),
        },
      ],
    },
  };

  // 1. Pill style emits 24-bit background fill (48;2;)
  const pillOut = formatCliStatusLineCapsule(slotCtx, {
    slots: ['tps', 'context', 'gemini_5h'],
    gaugeStyle: 'pill',
    language: 'zh-CN',
    color: true,
  });
  assert.match(pillOut, /\x1b\[48;2;/);

  // 2. Bar style emits transparent Braille/block bar without 48;2; background codes
  const barOut = formatCliStatusLineCapsule(slotCtx, {
    slots: ['tps', 'context', 'gemini_5h'],
    gaugeStyle: 'bar',
    language: 'zh-CN',
    color: true,
  });
  assert.doesNotMatch(barOut, /\x1b\[48;2;/);
  assert.match(barOut, /[█▏▎▍▌▋▊▉]/);
  assert.match(barOut, /⢕/);

  // 3. Compact style emits clean text-only gauges without 48;2; or bar glyphs
  const compactOut = formatCliStatusLineCapsule(slotCtx, {
    slots: ['tps', 'context', 'gemini_5h'],
    gaugeStyle: 'compact',
    language: 'zh-CN',
    color: true,
  });
  assert.doesNotMatch(compactOut, /\x1b\[48;2;/);
  assert.doesNotMatch(compactOut, /[█⢕]/);
  assert.match(compactOut, /上下文.*42%/);
  assert.match(compactOut, /G5h.*40%/);

  // 4. Structured JSON output includes model, speed, context, and quota pool snapshots
  const jsonSnap = buildCliJsonStatusOutput(slotCtx, {
    modelDisplayName: 'Gemini 4 Neon',
    modelEffort: 'xhigh',
    cycleMode: 'auto',
    nowMs,
  });
  assert.equal(jsonSnap.model.displayName, 'Gemini 4 Neon');
  assert.equal(jsonSnap.model.effort, 'xhigh');
  assert.equal(jsonSnap.speed.tps, 52.3);
  assert.equal(jsonSnap.context.usedPct, 42);
  assert.equal(jsonSnap.quotas.autoRemainingPct, 40);
  assert.equal(jsonSnap.quotas.pools.length, 1);
  assert.equal(jsonSnap.quotas.pools[0].poolKey, 'Gemini');
  assert.equal(jsonSnap.quotas.pools[0].remaining5hPct, 40);
  assert.equal(jsonSnap.quotas.pools[0].remainingWeeklyPct, 80);
});

test('conversation undo preserves 10-channel context breakdown across unindexed tail gen_metadata, stripped history, and cold fallback', async () => {
  const baseMs = Date.parse('2026-11-23T17:00:00.000Z');
  const iso = (offsetSec) => new Date(baseMs + offsetSec * 1000).toISOString();

  // Case 1: Undo after a prior compaction leaves trailing gen_metadata with stepIndices: [] and full tokenBreakdown
  const undoPostCompactSteps = [
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {
        createdAt: iso(0),
        completedAt: iso(2),
        sourceTrajectoryStepInfo: { stepIndex: 10 },
        modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '180000', cacheReadTokens: '0', outputTokens: '800' },
      },
      plannerResponse: { response: 'before compact' },
    },
    {
      type: 'CORTEX_STEP_TYPE_CHECKPOINT',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {
        createdAt: iso(5),
        completedAt: iso(7),
        sourceTrajectoryStepInfo: { stepIndex: 11 },
        modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '181000', cacheReadTokens: '0', outputTokens: '3200', responseOutputTokens: '3100' },
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {
        createdAt: iso(15),
        completedAt: iso(18),
        sourceTrajectoryStepInfo: { stepIndex: 14 },
        modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '5000', cacheReadTokens: '95000', outputTokens: '1200' },
      },
      plannerResponse: { response: 'post compact step' },
    },
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: iso(25), sourceTrajectoryStepInfo: { stepIndex: 15 } },
      userInput: { userResponse: 'undone prompt' },
    },
  ];
  const undoPostCompactGen = [
    {
      stepIndices: [14],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M37',
        chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 99000, maxContextTokens: 256000 } },
      },
    },
    {
      stepIndices: [],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M37',
        chatStartMetadata: {
          contextWindowMetadata: {
            estimatedTokensUsed: 101200,
            maxContextTokens: 256000,
            tokenBreakdown: {
              groups: [
                { type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 6000 },
                { type: 'TOKEN_TYPE_SKILLS', numTokens: 1800 },
                { type: 'TOKEN_TYPE_USER_RULES', numTokens: 2200 },
                {
                  type: 'TOKEN_TYPE_TOOLS',
                  numTokens: 7000,
                  children: [
                    { name: 'read_file', numTokens: 6500 },
                    { name: 'mcp_custom_tool', numTokens: 500 },
                  ],
                },
                {
                  type: 'TOKEN_TYPE_CHAT_MESSAGES',
                  numTokens: 84200,
                  children: [
                    { name: '11: CHECKPOINT', numTokens: 3200 },
                    { name: '12: USER_INPUT', numTokens: 1000 },
                    { name: '13: GENERIC', numTokens: 45000 },
                    { name: '14: PLANNER_RESPONSE', numTokens: 35000 },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  ];

  const h1 = backendHarness({
    trajectories: {
      'conv-undo-si-empty': {
        trajectory: { steps: undoPostCompactSteps, generatorMetadata: undoPostCompactGen },
      },
    },
    summaries: {
      'conv-undo-si-empty': {
        annotations: { title: 'Undo Post Compact' },
        stepCount: 4,
        lastModifiedTime: iso(25),
        status: 'IDLE',
      },
    },
  });
  const p1 = await h1.buildTelemetryPayloadInternal('conv-undo-si-empty');
  const ctx1 = p1.activeConversation.context;
  assert.equal(ctx1.totalTokens, 101200);
  assert.ok(ctx1.systemPromptTokens > 5500, `sysPrompt=${ctx1.systemPromptTokens}`);
  assert.ok(ctx1.systemToolsTokens > 6000, `sysTools=${ctx1.systemToolsTokens}`);
  assert.ok(ctx1.mcpToolsTokens > 400, `mcpTools=${ctx1.mcpToolsTokens}`);
  assert.ok(ctx1.skillsTokens > 1500, `skills=${ctx1.skillsTokens}`);
  assert.ok(ctx1.userRulesTokens > 2000, `rules=${ctx1.userRulesTokens}`);
  assert.equal(
    ctx1.userInputTokens +
      ctx1.assistantTokens +
      ctx1.toolResultsTokens +
      ctx1.subagentTokens +
      ctx1.checkpointTokens +
      ctx1.systemToolsTokens +
      ctx1.mcpToolsTokens +
      ctx1.skillsTokens +
      ctx1.systemPromptTokens +
      ctx1.userRulesTokens,
    101200
  );

  // Case 2: Trailing compaction step with unindexed pre-compaction gen_metadata inherits static channels without inflating checkpoint
  const h2 = backendHarness({
    trajectories: {
      'conv-undo-tail-compact': {
        trajectory: {
          steps: undoPostCompactSteps.slice(0, 2),
          generatorMetadata: [
            {
              stepIndices: [10],
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M37',
                chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 180000, maxContextTokens: 512000 } },
              },
            },
            {
              stepIndices: [],
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M37',
                chatStartMetadata: {
                  contextWindowMetadata: {
                    estimatedTokensUsed: 180000,
                    maxContextTokens: 512000,
                    tokenBreakdown: {
                      groups: [
                        { type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 10000 },
                        { type: 'TOKEN_TYPE_TOOLS', numTokens: 8000 },
                        { type: 'TOKEN_TYPE_SKILLS', numTokens: 2000 },
                        { type: 'TOKEN_TYPE_USER_RULES', numTokens: 3000 },
                        { type: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: 157000 },
                      ],
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
    summaries: {
      'conv-undo-tail-compact': {
        annotations: { title: 'Tail Compact' },
        stepCount: 2,
        lastModifiedTime: iso(7),
        status: 'IDLE',
      },
    },
  });
  const p2 = await h2.buildTelemetryPayloadInternal('conv-undo-tail-compact');
  const ctx2 = p2.activeConversation.context;
  assert.equal(ctx2.checkpointTokens, 3100);
  assert.equal(ctx2.systemPromptTokens, 10000);
  assert.equal(ctx2.systemToolsTokens, 8000);
  assert.equal(ctx2.skillsTokens, 2000);
  assert.equal(ctx2.userRulesTokens, 3000);
  assert.equal(ctx2.userInputTokens, 0);
  assert.equal(ctx2.totalTokens, 26100);

  // Case 3: Live multi-turn undo deletes tail gen_metadata leaving only stripped 1KB rows -> cached breakdown + static baseline survive
  const step1 = {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt: iso(0),
      completedAt: iso(2),
      sourceTrajectoryStepInfo: { stepIndex: 1 },
      modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '20000', cacheReadTokens: '0', outputTokens: '1000' },
    },
    plannerResponse: { response: 'turn 1', toolCalls: [{ name: 'read_file' }] },
  };
  const step2 = {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt: iso(10),
      completedAt: iso(12),
      sourceTrajectoryStepInfo: { stepIndex: 3 },
      modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '5000', cacheReadTokens: '21000', outputTokens: '1500' },
    },
    plannerResponse: { response: 'turn 2' },
  };
  const step3 = {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt: iso(20),
      completedAt: iso(22),
      sourceTrajectoryStepInfo: { stepIndex: 5 },
      modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '4000', cacheReadTokens: '27500', outputTokens: '800' },
    },
    plannerResponse: { response: 'turn 3' },
  };
  const liveTraj = {
    trajectory: {
      steps: [step1, step2, step3],
      generatorMetadata: [
        { stepIndices: [1], chatModel: { model: 'MODEL_PLACEHOLDER_M37', chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 20000, maxContextTokens: 256000 } } } },
        { stepIndices: [3], chatModel: { model: 'MODEL_PLACEHOLDER_M37', chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 26000, maxContextTokens: 256000 } } } },
        {
          stepIndices: [5],
          chatModel: {
            model: 'MODEL_PLACEHOLDER_M37',
            chatStartMetadata: {
              contextWindowMetadata: {
                estimatedTokensUsed: 31500,
                maxContextTokens: 256000,
                tokenBreakdown: {
                  groups: [
                    { type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 6000 },
                    { type: 'TOKEN_TYPE_TOOLS', numTokens: 7000 },
                    { type: 'TOKEN_TYPE_SKILLS', numTokens: 1500 },
                    { type: 'TOKEN_TYPE_USER_RULES', numTokens: 2000 },
                    { type: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: 15000 },
                  ],
                },
              },
            },
          },
        },
      ],
    },
  };
  const liveSum = {
    annotations: { title: 'Live Undo Session' },
    stepCount: 3,
    lastModifiedTime: iso(22),
    status: 'IDLE',
  };
  const h3 = backendHarness({
    trajectories: { 'conv-live-undo': liveTraj },
    summaries: { 'conv-live-undo': liveSum },
  });
  const beforeUndo = await h3.buildTelemetryPayloadInternal('conv-live-undo');
  assert.equal(beforeUndo.activeConversation.context.totalTokens, 32300);

  // User clicks Confirm Undo back to step 2 -> step3 and its full gen_metadata[2] are deleted!
  liveTraj.trajectory.steps = [step1, step2];
  liveTraj.trajectory.generatorMetadata = liveTraj.trajectory.generatorMetadata.slice(0, 2);
  liveSum.stepCount = 2;
  liveSum.lastModifiedTime = iso(30);

  const afterUndo = await h3.buildTelemetryPayloadInternal('conv-live-undo');
  const ctx3 = afterUndo.activeConversation.context;
  assert.equal(ctx3.totalTokens, 27500);
  assert.equal(ctx3.systemPromptTokens, 6000);
  assert.equal(ctx3.systemToolsTokens, 7000);
  assert.equal(ctx3.skillsTokens, 1500);
  assert.equal(ctx3.userRulesTokens, 2000);
  assert.equal(ctx3.assistantTokens, 2500);
  assert.equal(ctx3.toolResultsTokens, 5000);
  assert.equal(ctx3.userInputTokens, 3500);
  assert.equal(
    ctx3.userInputTokens +
      ctx3.assistantTokens +
      ctx3.toolResultsTokens +
      ctx3.subagentTokens +
      ctx3.checkpointTokens +
      ctx3.systemToolsTokens +
      ctx3.mcpToolsTokens +
      ctx3.skillsTokens +
      ctx3.systemPromptTokens +
      ctx3.userRulesTokens,
    27500
  );
  // Accounting & usage totals never shrink after undo; reverted step stays in recentSteps with isReverted: true
  assert.equal(afterUndo.activeConversation.totalTokens, beforeUndo.activeConversation.totalTokens);
  assert.equal(afterUndo.activeConversation.sessionCostUsd, beforeUndo.activeConversation.sessionCostUsd);
  assert.equal(afterUndo.consumption.session.totalTokens, beforeUndo.consumption.session.totalTokens);
  assert.equal(afterUndo.consumption.account.totalTokens, beforeUndo.consumption.account.totalTokens);
  assert.equal(afterUndo.activeConversation.stepCount, 3);
  assert.equal(afterUndo.activeConversation.recentSteps.length, 3);
  assert.equal(afterUndo.activeConversation.recentSteps[0].stepIndex, 5);
  assert.equal(afterUndo.activeConversation.recentSteps[0].isReverted, true);
  assert.equal(Boolean(afterUndo.activeConversation.recentSteps[1].isReverted), false);
  assert.equal(Boolean(afterUndo.activeConversation.recentSteps[2].isReverted), false);

  // Branching after undo: new turn reuses stepIndex 5 with a newer timestamp -> both reverted & new active step coexist
  const step3Branched = {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt: iso(45),
      completedAt: iso(47),
      sourceTrajectoryStepInfo: { stepIndex: 5 },
      modelUsage: { model: 'MODEL_PLACEHOLDER_M37', inputTokens: '3000', cacheReadTokens: '26000', outputTokens: '1200' },
    },
    plannerResponse: { response: 'branched turn 3' },
  };
  liveTraj.trajectory.steps = [step1, step2, step3Branched];
  liveSum.stepCount = 3;
  liveSum.lastModifiedTime = iso(47);

  const afterBranch = await h3.buildTelemetryPayloadInternal('conv-live-undo');
  assert.equal(afterBranch.activeConversation.stepCount, 4);
  assert.equal(afterBranch.activeConversation.recentSteps.length, 4);
  assert.equal(
    afterBranch.activeConversation.totalTokens,
    beforeUndo.activeConversation.totalTokens + 3000 + 26000 + 1200
  );
  assert.equal(
    afterBranch.consumption.account.totalTokens,
    beforeUndo.consumption.account.totalTokens + 3000 + 26000 + 1200
  );
  assert.equal(afterBranch.activeConversation.recentSteps[0].stepIndex, 5);
  assert.equal(Boolean(afterBranch.activeConversation.recentSteps[0].isReverted), false);
  assert.equal(afterBranch.activeConversation.recentSteps[1].stepIndex, 5);
  assert.equal(afterBranch.activeConversation.recentSteps[1].isReverted, true);
  assert.equal(afterBranch.activeConversation.context.totalTokens, 30200);

  // Case 4: Cold start on an already-undone session with zero breakdowns and no compaction still populates channels (never all-0)
  const h4 = backendHarness({
    trajectories: {
      'conv-cold-undo': {
        trajectory: {
          steps: [step1, step2],
          generatorMetadata: [
            { stepIndices: [1], chatModel: { model: 'MODEL_PLACEHOLDER_M37', chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 20000, maxContextTokens: 256000 } } } },
            { stepIndices: [3], chatModel: { model: 'MODEL_PLACEHOLDER_M37', chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 26000, maxContextTokens: 256000 } } } },
          ],
        },
      },
    },
    summaries: {
      'conv-cold-undo': {
        annotations: { title: 'Cold Undo Session' },
        stepCount: 2,
        lastModifiedTime: iso(12),
        status: 'IDLE',
      },
    },
  });
  const coldPayload = await h4.buildTelemetryPayloadInternal('conv-cold-undo');
  const ctx4 = coldPayload.activeConversation.context;
  assert.equal(ctx4.totalTokens, 27500);
  assert.equal(ctx4.assistantTokens, 2500);
  assert.equal(ctx4.toolResultsTokens, 5000);
  assert.equal(ctx4.userInputTokens, 20000);
  assert.equal(ctx4.userInputTokens + ctx4.assistantTokens + ctx4.toolResultsTokens, 27500);
});

test('trendSeries respects strict window bounds without 6h out-of-window padding and subdivides <2h spans into 1m/5m/15m slots', async () => {
  const mkStep = (atMs, tok) => ({
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt: new Date(atMs).toISOString(),
      finishedGeneratingAt: new Date(atMs + 4000).toISOString(),
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M37',
        inputTokens: String(tok),
        cacheReadTokens: '0',
        outputTokens: '0',
      },
    },
    plannerResponse: { response: 'ok' },
  });

  // Anchor clock to local 2026-11-24 03:27:40 (3h 27m into 'today'; 27m into a cycle reset at 03:00:00)
  const dayStart = new Date(2026, 10, 24, 0, 0, 0, 0).getTime();
  let fakeNowMs = dayStart + 3 * 3600_000 + 27 * 60_000 + 40_000;

  const cycleStartMs = dayStart + 3 * 3600_000;
  const weeklyResetIso = new Date(cycleStartMs + 7 * 24 * 3600_000).toISOString();
  const fiveHourResetIso = new Date(cycleStartMs + 5 * 3600_000).toISOString();

  const h = backendHarness({
    clock: () => fakeNowMs,
    userStatus: {
      email: 'trend@example.com',
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 3.8 Flash (High)',
            modelOrAlias: { model: 'MODEL_PLACEHOLDER_M37' },
            quotaInfo: { remainingFraction: 0.9, resetTime: fiveHourResetIso },
          },
        ],
      },
    },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            { remainingFraction: 0.9, resetTime: fiveHourResetIso },
            { remainingFraction: 0.95, resetTime: weeklyResetIso },
          ],
        },
      ],
    },
    trajectories: {
      cTrend: {
        trajectory: {
          steps: [
            mkStep(dayStart + 2 * 3600_000 + 10 * 60_000, 30_000), // 02:10 (previous cycle)
            mkStep(cycleStartMs + 18 * 60_000, 5_000), // 03:18 (current cycle)
          ],
          generatorMetadata: [],
        },
      },
    },
    summaries: {
      cTrend: { stepCount: 2, lastModifiedTime: new Date(fakeNowMs).toISOString(), status: 'IDLE' },
    },
  });

  // 1. 'today' at 03:27 (>= 2h): strictly 4 hourly slots (00:00..03:00), never padded to future 04:00/05:00
  const pToday = await h.buildTelemetryPayloadInternal('cTrend', false, { range: 'today' });
  assert.deepEqual(
    Array.from(pToday.consumption.trendSeries, (s) => s.label),
    ['00:00', '01:00', '02:00', '03:00']
  );
  assert.equal(pToday.consumption.trendSeries[0].granularity, 'hour');
  assert.equal(pToday.consumption.trendSeries[2].tokens, 30_000);
  assert.equal(pToday.consumption.trendSeries[3].tokens, 5_000);

  // 2. 'cycle' 27m after reset (< 1h): 6 five-minute slots (03:00..03:25), never reaching back to 22:00..02:00
  const pCycle = await h.buildTelemetryPayloadInternal('cTrend', false, { range: 'cycle' });
  assert.deepEqual(
    Array.from(pCycle.consumption.trendSeries, (s) => s.label),
    ['03:00', '03:05', '03:10', '03:15', '03:20', '03:25']
  );
  assert.equal(pCycle.consumption.trendSeries[0].granularity, 'minute');
  assert.equal(pCycle.consumption.trendSeries[0].stepMinutes, 5);
  assert.equal(pCycle.consumption.trendSeries[3].tokens, 5_000); // 03:18 falls in 03:15 - 03:20

  // 3. Rewind to 01:20 (< 2h) on a fresh harness and verify 15m -> 1h cache invalidation across the 2h boundary
  fakeNowMs = dayStart + 1 * 3600_000 + 20 * 60_000;
  const hTransition = backendHarness({
    clock: () => fakeNowMs,
    trajectories: {
      cEarly: {
        trajectory: {
          steps: [mkStep(dayStart + 35 * 60_000, 8_000)],
          generatorMetadata: [],
        },
      },
    },
    summaries: {
      cEarly: { stepCount: 1, lastModifiedTime: new Date(fakeNowMs).toISOString(), status: 'IDLE' },
    },
  });
  const pEarly = await hTransition.buildTelemetryPayloadInternal('cEarly', false, { range: 'today' });
  assert.deepEqual(
    Array.from(pEarly.consumption.trendSeries, (s) => s.label),
    ['00:00', '00:15', '00:30', '00:45', '01:00', '01:15']
  );
  assert.equal(pEarly.consumption.trendSeries[0].granularity, 'minute');
  assert.equal(pEarly.consumption.trendSeries[0].stepMinutes, 15);
  assert.equal(pEarly.consumption.trendSeries[2].tokens, 8_000);

  // Advance clock to 02:05 (>= 2h): snapshot cache must invalidate stepMs and switch to 3 hourly slots
  fakeNowMs = dayStart + 2 * 3600_000 + 5 * 60_000;
  const pAfter2h = await hTransition.buildTelemetryPayloadInternal('cEarly', false, { range: 'today' });
  assert.deepEqual(
    Array.from(pAfter2h.consumption.trendSeries, (s) => s.label),
    ['00:00', '01:00', '02:00']
  );
  assert.equal(pAfter2h.consumption.trendSeries[0].granularity, 'hour');
  assert.equal(pAfter2h.consumption.trendSeries[0].tokens, 8_000);
});

test('executeSettingsAction preserves 1-row mixed Bento layout when adding/reordering metrics while still supporting genuine legacy style-only upgrades', () => {
  const h = backendHarness();

  // Save 1-row mixed Bento layout: 2x1 + 1x1 + 1x1 (derived overviewMetricStyle === 'hybrid')
  const r1 = JSON.parse(
    h.executeSettingsAction({
      overviewMetricRows: 1,
      overviewMetricSizes: { tps: 'wide' },
      overviewMetrics: ['tps', 'ttft', 'cache_hit'],
    }).body
  );
  assert.equal(r1.overviewMetricRows, 1);
  assert.deepEqual(r1.overviewMetricSizes, { tps: 'wide' });
  assert.equal(r1.overviewMetricStyle, 'hybrid');

  // Adding a 4th metric or reordering MUST keep overviewMetricRows === 1 & sizes (even if derived style 'hybrid' is sent without rows/sizes)
  const r2 = JSON.parse(
    h.executeSettingsAction({
      overviewMetrics: ['tps', 'ttft', 'cache_hit', 'step_cost'],
      overviewMetricStyle: 'hybrid',
    }).body
  );
  assert.equal(r2.overviewMetricRows, 1, 'Adding 4th metric must NOT force 2 rows');
  assert.deepEqual(r2.overviewMetricSizes, { tps: 'wide' }, 'Adding 4th metric must NOT reset card sizes to tall');

  // Reordering with explicit Bento rows & sizes keeps middle wide card intact
  const r3 = JSON.parse(
    h.executeSettingsAction({
      overviewMetrics: ['ttft', 'tps', 'cache_hit', 'step_cost'],
      overviewMetricRows: 1,
      overviewMetricSizes: { tps: 'wide' },
      overviewMetricStyle: 'hybrid',
    }).body
  );
  assert.equal(r3.overviewMetricRows, 1);
  assert.deepEqual(r3.overviewMetricSizes, { tps: 'wide' });
  assert.deepEqual(r3.overviewMetrics, ['ttft', 'tps', 'cache_hit', 'step_cost']);

  // Genuine legacy style-only upgrade (e.g. changing style to 'large' without rows/sizes) migrates cleanly to 1/3 ('third') cards
  const r4 = JSON.parse(h.executeSettingsAction({ overviewMetricStyle: 'large' }).body);
  assert.equal(r4.overviewMetricRows, 1);
  assert.equal(r4.overviewMetricStyle, 'large');
  assert.equal(r4.overviewMetricSizes.ttft, 'third');
  assert.equal(r4.overviewMetricSizes.tps, 'third');

  // Metric card text visibility mode defaults to 'title' and persists cleanly across both overview & hover
  assert.equal(r4.overviewMetricTextMode, 'title');
  assert.equal(r4.hoverMetricTextMode, 'title');
  const r5 = JSON.parse(
    h.executeSettingsAction({
      overviewMetricTextMode: 'none',
      hoverMetricTextMode: 'both',
    }).body
  );
  assert.equal(r5.overviewMetricTextMode, 'none');
  assert.equal(r5.hoverMetricTextMode, 'both');
});
