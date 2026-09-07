// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
// Kept for backward compatibility with existing imports.
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl,
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
  getApiKeys, getApiKeyById, createApiKey, updateApiKey, deleteApiKey, validateApiKey,
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
  exportDb, importDb,
} from "@/lib/db/index.js";

// Legacy: modelProbe.js imported getDisabledModels from here. Real home is
// `@/lib/disabledModelsDb` — re-export so the legacy import path still works.
export { getDisabledModels } from "@/lib/disabledModelsDb.js";
