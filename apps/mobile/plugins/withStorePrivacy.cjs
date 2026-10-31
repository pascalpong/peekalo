const { withInfoPlist } = require('expo/config-plugins');

// Only registered by the explicit store profile. Dev-client adds Bonjour/local
// network descriptions even to resolved Release configuration; the store app
// has no local-server feature. Keep changes in CNG, never generated projects.
module.exports = config => withInfoPlist(config, config => {
  delete config.modResults.NSBonjourServices;
  delete config.modResults.NSLocalNetworkUsageDescription;
  delete config.modResults.NSFaceIDUsageDescription;
  config.modResults.NSAppTransportSecurity = {
    ...config.modResults.NSAppTransportSecurity,
    NSAllowsArbitraryLoads: false,
    NSAllowsLocalNetworking: false,
  };
  return config;
});
