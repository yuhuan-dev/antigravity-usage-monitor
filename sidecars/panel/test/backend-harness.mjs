import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
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
  '../shared/currency-catalog.mjs',
  '../shared/telemetry-display-rules.mjs',
  '../shared/window-bridge-protocol.mjs',
  '../shared/host-i18n-protocol.mjs',
  '../shared/host-theme.mjs',
  '../shared/workspace-uri.mjs',
  '../shared/prompt-clean.mjs',
  '../backend/fs-atomic.mjs',
  '../backend/context-windows.mjs',
  '../backend/http-helpers.mjs',
  '../backend/settings-schema.mjs',
  '../backend/sqlite-client.mjs',
  '../backend/trajectory-sqlite-ledger.mjs',
  '../backend/trajectory-cache-store.mjs',
  '../backend/config.mjs',
  '../backend/devtools-port-probe.mjs',
  '../backend/host-theme-store.mjs',
  '../backend/account-quota-history.mjs',
  '../backend/account-vault-crypto.mjs',
  '../backend/account-keyring-store.mjs',
  '../backend/account-oauth.mjs',
  '../backend/account-login.mjs',
  '../backend/account-switch.mjs',
  '../backend/endpoint-registry.mjs',
  '../backend/proto-wire.mjs',
  '../backend/cli-sqlite-reader.mjs',
  '../backend/cli-statusline-config.mjs',
  '../backend/session-migrator.mjs',
  '../backend/ls-discovery.mjs',
  '../backend/ide-remote-ssh.mjs',
  '../backend/pricing-catalog.mjs',
  '../backend/fx-rates.mjs',
  '../backend/plugin-updater.mjs',
  '../backend/ls-rpc.mjs',
  '../backend/cloudcode-proxy.mjs',
  '../backend/host-i18n/http-fetch.mjs',
  '../backend/host-i18n/pack-manager.mjs',
  '../backend/host-i18n/runtime-translator.mjs',
  '../backend/host-i18n/index.mjs',
  '../backend/model-pricing.mjs',
  '../backend/quota-pools.mjs',
  '../backend/safety-monitor-scanner.mjs',
  '../backend/quota-reservation.mjs',
  '../backend/transcript-fallback.mjs',
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
  const pendingTmpWrites = new Map();
  const commitSave = (p, s) => {
    const norm = String(p).replace(/\\/g, '/');
    const parsed = typeof s === 'string' ? JSON.parse(s) : s;
    state.saves.push({ path: p, data: parsed });
    if (norm.endsWith('settings.json')) {
      state.settings = parsed;
    }
    if (norm.endsWith('remote_pricing_cache.json')) {
      state.remoteCatalog = parsed;
    }
  };
  const ctx={
    ...metricsImplementation, URL, AbortSignal, Buffer, TextDecoder, ...timerApi, isDeepStrictEqual, createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual,
    ...(clock ? { Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock()])); }
      static now() { return clock(); }
    } } : {}),
    process:{pid:12345,platform:'win32',env:{ANTIGRAVITY_EXECUTABLE_DATA_DIR:'/test-data',ANTIGRAVITY_LS_ADDRESS:'test.invalid',ANTIGRAVITY_CSRF_TOKEN:'test'}},
    console:{error:m=>state.errors.push(m)},
    cpSync:()=>{},
    rmSync:()=>{},
    renameSync:(from, to)=>{
      const key = String(from);
      if (pendingTmpWrites.has(key)) {
        const staged = pendingTmpWrites.get(key);
        pendingTmpWrites.delete(key);
        commitSave(to, staged);
      }
    },
    unlinkSync:(p)=>{
      pendingTmpWrites.delete(String(p));
    },
    execFile:execFileImpl || ((cmd,args,opts,cb)=>{
      const fn = typeof opts === 'function' ? opts : cb;
      fn(new Error('execFile not mocked'));
    }),
    spawnSync:()=>({status:1,stdout:'',stderr:''}),
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
    readdirSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      if (diskDirs?.[norm] instanceof Error) throw diskDirs[norm];
      if (diskDirs && Array.isArray(diskDirs[norm])) return diskDirs[norm];
      return [];
    },
    statSync:(p, opts)=>{
      const norm = String(p).replace(/\\/g, '/');
      if (opts?.throwIfNoEntry === false && !ctx.existsSync(p)) return undefined;
      if (norm.endsWith('/.system_generated/logs/transcript.jsonl')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/i);
        const lines = m && state.transcripts?.[m[1]];
        if (lines) {
          const text = Array.isArray(lines) ? lines.map(x => JSON.stringify(x)).join('\n') : String(lines);
          return {mtimeMs:state.transcriptMtimeMs,size:Buffer.byteLength(text,'utf8')};
        }
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
    lstatSync:(p, opts)=>{
      const st = ctx.statSync(p, opts);
      return st ? {...st, isSymbolicLink:()=>false} : st;
    },
    readlinkSync:()=>'',
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
      if (norm.endsWith('.ps1')) {
        return fs.readFileSync(new URL(`../backend/${path.basename(norm)}`, import.meta.url), 'utf8');
      }
      return JSON.stringify(cache);
    },
    writeFileSync:(p,s)=>{
      if (/\.tmp-\d+$/.test(String(p))) {
        pendingTmpWrites.set(String(p), s);
        return;
      }
      commitSave(p, s);
    },
    writeTrajectoryCacheFile:(p,data)=>{
      if (state.cacheWriteError) throw state.cacheWriteError;
      state.saves.push({path:p,data:JSON.parse(JSON.stringify(data))});
    },
    homedir:()=>'/test-home',dirname:path.dirname,join:path.join,basename:path.basename,pathWin32:path.win32,winPath:path.win32,posixPath:path.posix,delimiter:path.delimiter,pathToFileURL,fileURLToPath:()=>mainPath,
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
  vm.runInNewContext(source+'\n globalThis.api={buildTelemetryPayloadInternal,executeTelemetryAction,dispatchBridgeApiRequest,executeAccountCredentialAction,callLsRpc,getDefaultCloudCodeProxyStatus,computeStepCost,resolveModelInfo,resolvePricingAt,inferFamilyFromProviderOrKey,isNeonModelIdentifier,isArgonModelIdentifier,isCarbonModelIdentifier,getBaseModelLabel,formatUpstreamModelId,PLACEHOLDER_MAP,normalizeQuotaFraction,classifyOfficialBucketWindow,classifyQuotaPoolIdentity,buildOfficialQuotaPools,resolveTimeWindow,sanitizeCatalogPayload,rebuildActiveCatalog,getPricingPhaseEpoch,detectCustomGitForkRepo,persistTrajectoryCacheIfNeeded,flushTrajectoryCacheNow,getCachedTrajectory,listCachedTrajectoryEntries,hasPendingTrajectoryCacheSave,syncCloudCatalog,getCloudStatus,isValidSemver,compareSemver,performPluginUpdate,resolveMigratedGitRemoteUrl,loadSettings,executeSettingsAction,executeModelContextWindowAction,executeResetSettingsAction,executeRebuildCacheAction,clearRuntimeCaches,normalizeTopbarCapsuleSlots,normalizeTopbarMultiSessionMode,isTopbarMultiSessionVisible,normalizeContextAgentMode,normalizeCliStatusLineSlots,resolveEffectiveCliStatusLineSlots,normalizeHoverModules,normalizeOverviewModules,normalizeOverviewMetrics,normalizeStepTableColumns,normalizeStepTokenComboFormat,parseStepTokenComboSegments,normalizeModelDisplayMode,normalizePopoverWidthMode,normalizePopoverWidth,normalizeStandalonePort,normalizeAutoConfigureLaunch,normalizeEnableRemoteSshTelemetry,parseIdeRemoteAuthority,setStandalonePortListener,parseAnnotationPbtxtTitle,readLocalSummarySnapshot,readLocalSqliteTrajectory,computeSqliteWalSig,getLocalCacheRebuildStatus,stopLocalBackgroundCacheRebuild,buildCliStatusSnapshot,buildCliStatusLineCommand,isManagedCliStatusLineCommand,extractManagedCliStatusLineFlags,getCliStatusLineRuntimeStatus,applyCliStatusLineToSettingsObject,cliDisplayWidth,parseCliModelAndEffort,formatCliStatusLineCapsule,registerRemoteEndpoint,getRegisteredRemoteEndpoint,resolveEndpointContext,clearRemoteEndpointCaches,clearRemoteEndpointRegistry,setRemoteWindowRpcInvoker,setLoopbackHttpsRequester,getEndpointCacheStore,pruneStaleRemoteEndpoints,trackEndpointRequestStart,trackEndpointRequestEnd,shouldRemoteEndpointPreferTier2,markRemoteEndpointPreferTier2};',ctx);
  return {...ctx.api,state};
}
