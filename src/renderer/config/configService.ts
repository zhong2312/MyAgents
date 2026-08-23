// Barrel re-export — preserves all existing import paths
// Domain modules live in ./services/

// configStore (infrastructure)
export { createAsyncLock, withConfigLock, withProjectsLock } from './services/configStore';

// appConfigService
export {
    loadAppConfig,
    saveAppConfig,
    atomicModifyConfig,
    ensureBundledWorkspace,
    ensureSelfAwarenessWorkspace,
    mergePresetCustomModels,
} from './services/appConfigService';

// providerService
export {
    getAllProviders,
    loadCustomProviders,
    saveCustomProvider,
    deleteCustomProvider,
    saveApiKey,
    loadApiKeys,
    deleteApiKey,
    saveProviderVerifyStatus,
    loadProviderVerifyStatus,
    deleteProviderVerifyStatus,
    rebuildAndPersistAvailableProviders,
    isProviderAvailable,
    getFirstAvailableProvider,
    resolveProvider,
    resolveBuiltinSelection,
    pairBuiltinSelection,
    isImageUnderstandingSelectionAvailable,
} from './services/providerService';
export type { ProviderModelPair } from './services/providerService';

// mcpService
export {
    getAllMcpServers,
    getEnabledMcpServerIds,
    toggleMcpServerEnabled,
    addCustomMcpServer,
    deleteCustomMcpServer,
    saveMcpServerEnv,
    getMcpServerEnv,
    saveMcpServerArgs,
    getMcpServerArgs,
    getEffectiveMcpServers,
    updateProjectMcpServers,
} from './services/mcpService';

// projectService
export {
    loadProjects,
    saveProjects,
    addProject,
    updateProject,
    patchProject,
    removeOrHideProject,
    touchProject,
} from './services/projectService';

// projectSettingsService
export {
    loadProjectSettings,
    saveProjectSettings,
} from './services/projectSettingsService';
