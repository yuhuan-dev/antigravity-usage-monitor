import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as metrics from '../trajectory-metrics.mjs';
import { stripModuleSyntax } from '../scripts/build-bundle.mjs';

const REAL_CATALOG_RAW = JSON.parse(
  fs.readFileSync(new URL('../../../pricing-catalog.json', import.meta.url), 'utf8')
);
const DEFAULT_BUNDLED_CATALOG = {
  schemaVersion: 1,
  pricing: REAL_CATALOG_RAW.pricing,
  placeholders: REAL_CATALOG_RAW.placeholders,
};

const BACKEND_MODULE_FILES = [
  '../shared/settings-normalization.mjs',
  '../shared/telemetry-display-rules.mjs',
  '../shared/window-bridge-protocol.mjs',
  '../backend/context-windows.mjs',
  '../backend/account-oauth.mjs',
  '../backend/account-switch.mjs',
  '../backend/http-helpers.mjs',
  '../backend/settings-schema.mjs',
  '../backend/config.mjs',
  '../backend/endpoint-registry.mjs',
  '../backend/sqlite-client.mjs',
  '../backend/proto-wire.mjs',
  '../backend/cli-sqlite-reader.mjs',
  '../backend/cli-statusline-config.mjs',
  '../backend/ls-discovery.mjs',
  '../backend/pricing-catalog.mjs',
  '../backend/plugin-updater.mjs',
  '../backend/ls-rpc.mjs',
  '../backend/model-pricing.mjs',
  '../backend/quota-pools.mjs',
  '../backend/local-scanner.mjs',
  '../backend/usage-aggregator.mjs',
  '../backend/telemetry-builder.mjs',
  '../backend/desktop-launcher-config.mjs',
  '../backend/window-bridge.mjs',
  '../backend/api-actions.mjs',
  '../main.mjs',
];

function loadCombinedBackendSource() {
  return BACKEND_MODULE_FILES.map((relPath) =>
    fs.readFileSync(new URL(relPath, import.meta.url), 'utf8')
  ).join('\n');
}

function stripEsmSyntax(rawSource, mainUrl) {
  return stripModuleSyntax(rawSource).replaceAll('import.meta.url', JSON.stringify(mainUrl));
}

export function backendHarness({
  cache={},
  deepStats=null,
  transcripts={},
  swarmMembers={},
  diskDirs={},
  settings={},
  trajectories={},
  summaries={},
  userStatus={},
  availableModels={},
  quotaSummary={groups:[]},
  localCatalog=DEFAULT_BUNDLED_CATALOG,
  remoteCatalog=null,
  pluginManifest=null,
  hasGitDir=false,
  gitConfigText=null,
  pluginRootPath=null,
  remoteFetch=null,
  execFileImpl=null,
  sourceText=null,
  clock=null,
  timerApi={ setTimeout, clearTimeout },
  metricsImplementation=metrics,
}={}) {
  const mainUrl = pluginRootPath ? `file://${pluginRootPath}/sidecars/panel/main.mjs` : 'file:///test/sidecars/panel/main.mjs';
  const mainPath = pluginRootPath ? `${pluginRootPath}/sidecars/panel/main.mjs` : '/test/sidecars/panel/main.mjs';
  const source = stripEsmSyntax(sourceText ?? loadCombinedBackendSource(), mainUrl);
  const state={calls:[],errors:[],saves:[],settings,trajectories,summaries,transcripts,transcriptMtimeMs:1,swarmMembers,swarmMembersMtimeMs:1,userStatus,quotaSummary,localCatalog,remoteCatalog,pluginManifest,hasGitDir,gitConfigText,deepStats,deepStatsMtimeMs:1};
  const ctx={
    ...metricsImplementation, URL, AbortSignal, Buffer, TextDecoder, ...timerApi, isDeepStrictEqual, createHash, randomUUID,
    ...(clock ? { Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock()])); }
      static now() { return clock(); }
    } } : {}),
    process:{platform:'win32',env:{ANTIGRAVITY_EXECUTABLE_DATA_DIR:'/test-data',ANTIGRAVITY_LS_ADDRESS:'test.invalid',ANTIGRAVITY_CSRF_TOKEN:'test'}},
    console:{error:m=>state.errors.push(m)},
    cpSync:()=>{},
    rmSync:()=>{},
    renameSync:()=>{},
    unlinkSync:()=>{},
    execFile:execFileImpl || ((cmd,args,opts,cb)=>{
      const fn = typeof opts === 'function' ? opts : cb;
      fn(new Error('execFile not mocked'));
    }),
    existsSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      if (norm.endsWith('settings.json') || norm.endsWith('trajectory_usage_cache.json')) return true;
      if (norm.endsWith('/antigravity/brain/.deep_stats_cache.json')) return Boolean(state.deepStats);
      if (norm.endsWith('pricing-catalog.json')) return Boolean(state.localCatalog);
      if (norm.endsWith('remote_pricing_cache.json')) return Boolean(state.remoteCatalog);
      if (norm.endsWith('plugin.json')) return Boolean(state.pluginManifest);
      if (norm.endsWith('/.system_generated/logs/transcript.jsonl')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/i);
        return Boolean(m && state.transcripts?.[m[1]]);
      }
      if (norm.endsWith('/.system_generated/swarm/members.json')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/swarm\/members\.json$/i);
        return Boolean(m && state.swarmMembers?.[m[1]]);
      }
      if (norm.endsWith('/.git')) return Boolean(state.hasGitDir || state.gitConfigText);
      if (norm.endsWith('/.git/config')) return Boolean(state.gitConfigText);
      if (diskDirs && Object.prototype.hasOwnProperty.call(diskDirs, norm)) return true;
      return false;
    },
    mkdirSync:()=>{},
    readdirSync:(p,options)=>{
      const norm = String(p).replace(/\\/g, '/');
      if (diskDirs?.[norm] instanceof Error) throw diskDirs[norm];
      if (Array.isArray(diskDirs?.[norm])) {
        return options?.withFileTypes ? diskDirs[norm].map(name =>
          typeof name === 'string' ? { name, isDirectory: () => true, isSymbolicLink: () => false } : name
        ) : diskDirs[norm];
      }
      throw Object.assign(new Error('Missing test directory'), { code: 'ENOENT' });
    },
    statSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      if (norm.endsWith('/.system_generated/logs/transcript.jsonl')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/i);
        const lines = m && state.transcripts?.[m[1]];
        if (lines) {
          const text = Array.isArray(lines) ? lines.map(x => JSON.stringify(x)).join('\n') : String(lines);
          return {mtimeMs:state.transcriptMtimeMs,size:Buffer.byteLength(text,'utf8'),isFile:()=>true};
        }
        throw Object.assign(new Error('Missing test transcript'), { code: 'ENOENT' });
      }
      if (norm.endsWith('/.system_generated/swarm/members.json')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/swarm\/members\.json$/i);
        const obj = m && state.swarmMembers?.[m[1]];
        if (obj) {
          const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
          return {mtimeMs:state.swarmMembersMtimeMs,size:Buffer.byteLength(text,'utf8')};
        }
      }
      if (norm.endsWith('/antigravity/brain/.deep_stats_cache.json') && state.deepStats) {
        return {mtimeMs:state.deepStatsMtimeMs,size:JSON.stringify(state.deepStats).length};
      }
      return {mtimeMs:0,size:0};
    },
    readFileSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      if (norm.endsWith('/.system_generated/logs/transcript.jsonl')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/i);
        const lines = m && state.transcripts?.[m[1]];
        return Array.isArray(lines) ? lines.map(x => JSON.stringify(x)).join('\n') : String(lines || '');
      }
      if (norm.endsWith('/.system_generated/swarm/members.json')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/swarm\/members\.json$/i);
        const obj = m && state.swarmMembers?.[m[1]];
        return typeof obj === 'string' ? obj : JSON.stringify(obj || {});
      }
      if (norm.endsWith('settings.json')) return JSON.stringify(state.settings);
      if (norm.endsWith('/antigravity/brain/.deep_stats_cache.json')) return JSON.stringify(state.deepStats);
      if (norm.endsWith('pricing-catalog.json')) return JSON.stringify(state.localCatalog);
      if (norm.endsWith('remote_pricing_cache.json')) return JSON.stringify(state.remoteCatalog);
      if (norm.endsWith('plugin.json')) return JSON.stringify(state.pluginManifest);
      if (norm.endsWith('/.git/config')) return String(state.gitConfigText || '');
      return JSON.stringify(cache);
    },
    writeFileSync:(p,s)=>{
      const norm = String(p).replace(/\\/g, '/');
      const parsed = typeof s === 'string' ? JSON.parse(s) : s;
      state.saves.push({path:p,data:parsed});
      if (norm.endsWith('settings.json')) {
        state.settings = parsed;
      }
      if (norm.endsWith('remote_pricing_cache.json')) {
        state.remoteCatalog = parsed;
      }
    },
    writeTrajectoryCacheFile:(p,data)=>{
      if (state.cacheWriteError) throw state.cacheWriteError;
      state.saves.push({path:p,data:JSON.parse(JSON.stringify(data))});
    },
    homedir:()=>'/test-home',dirname:path.dirname,join:path.join,basename:path.basename,delimiter:path.delimiter,pathToFileURL,fileURLToPath:()=>mainPath,
    Response:class {constructor(body,options){this.body=body;this.options=options;}},
    SidecarApp:class {page(){} api(){} run(){}},
    fetch:async(url,options={})=>{
      if (/^https?:\/\/(?!test\.invalid)/i.test(String(url)) && remoteFetch) {
        return remoteFetch(url, options);
      }
      const method=url.split('/').pop(); const body=options.body ? JSON.parse(options.body) : {};state.calls.push({method,body});
      if(method==='GetCascadeTrajectory') {
        const data=state.trajectories[body.cascadeId];
        if(data instanceof Error) throw data;
        return {ok:true,json:async()=>data||{}};
      }
      if(method==='RetrieveUserQuotaSummary') {
        const qs=await state.quotaSummary;
        if(qs instanceof Error) throw qs;
        return {ok:true,json:async()=>({response:qs})};
      }
      const data={GetUserStatus:{userStatus:state.userStatus},GetAvailableModels:{response:{models:availableModels}},GetAllCascadeTrajectories:{trajectorySummaries:state.summaries}}[method];
      return {ok:true,json:async()=>data};
    },
  };
  vm.runInNewContext(source+'\n globalThis.api={buildTelemetryPayloadInternal,executeTelemetryAction,dispatchBridgeApiRequest,executeAccountCredentialAction,callLsRpc,computeStepCost,resolveModelInfo,resolvePricingAt,inferFamilyFromProviderOrKey,isNeonModelIdentifier,isArgonModelIdentifier,isCarbonModelIdentifier,getBaseModelLabel,formatUpstreamModelId,PLACEHOLDER_MAP,normalizeQuotaFraction,classifyOfficialBucketWindow,classifyQuotaPoolIdentity,buildOfficialQuotaPools,resolveTimeWindow,sanitizeCatalogPayload,rebuildActiveCatalog,getPricingPhaseEpoch,detectCustomGitForkRepo,persistTrajectoryCacheIfNeeded,flushTrajectoryCacheNow,getCachedTrajectory,listCachedTrajectoryEntries,hasPendingTrajectoryCacheSave,syncCloudCatalog,getCloudStatus,isValidSemver,compareSemver,performPluginUpdate,resolveMigratedGitRemoteUrl,loadSettings,executeSettingsAction,executeModelContextWindowAction,executeResetSettingsAction,executeRebuildCacheAction,clearRuntimeCaches,normalizeTopbarCapsuleSlots,normalizeHoverModules,normalizeOverviewModules,normalizeOverviewMetrics,normalizeStepTableColumns,normalizeStepTokenComboFormat,parseStepTokenComboSegments,normalizeModelDisplayMode,normalizePopoverWidthMode,normalizePopoverWidth,normalizeStandalonePort,setStandalonePortListener,parseAnnotationPbtxtTitle,readLocalSummarySnapshot,readLocalSqliteTrajectory,computeSqliteWalSig,buildCliStatusSnapshot,buildCliStatusLineCommand,isManagedCliStatusLineCommand,applyCliStatusLineToSettingsObject,cliDisplayWidth,parseCliModelAndEffort,formatCliStatusLineCapsule,registerRemoteEndpoint,getRegisteredRemoteEndpoint,resolveEndpointContext,clearRemoteEndpointCaches,clearRemoteEndpointRegistry,setRemoteWindowRpcInvoker,setLoopbackHttpsRequester,getEndpointCacheStore,pruneStaleRemoteEndpoints,trackEndpointRequestStart,trackEndpointRequestEnd,shouldRemoteEndpointPreferTier2,markRemoteEndpointPreferTier2};',ctx);
  return {...ctx.api,state};
}
