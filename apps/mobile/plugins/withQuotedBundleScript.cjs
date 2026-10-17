const { withPodfile, withXcodeProject } = require('expo/config-plugins');

// Expo SDK 55's template invokes the resolved script without quoting its path.
// Preserve paths containing spaces when prebuild regenerates the native project.
module.exports = function withQuotedBundleScript(config) {
  config = withPodfile(config, mod => {
    const marker = '# Peekalo: preserve spaces in the Expo Constants script path.';
    const anchor = 'post_install do |installer|';
    const command = 'PROJECT_ROOT="${PROJECT_ROOT:-$PROJECT_DIR/../..}" PROJECT_DIR=Pods bash -l "$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh"';
    if (mod.modResults.contents.includes(marker)) {
      mod.modResults.contents = mod.modResults.contents.replace(
        "phase.shell_script = 'bash -l \"$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\"'",
        `phase.shell_script = '${command}'`,
      );
      return mod;
    }
    if (!mod.modResults.contents.includes(anchor)) throw new Error('Podfile post_install changed; review path quoting.');
    const fix = `${anchor}
    ${marker}
    installer.pods_project.targets.each do |target|
      next unless target.name == 'EXConstants'
      target.shell_script_build_phases.each do |phase|
        next unless phase.name == '[CP-User] Generate app.config for prebuilt Constants.manifest'
        phase.shell_script = '${command}'
      end
    end`;
    mod.modResults.contents = mod.modResults.contents.replace(anchor, fix);
    return mod;
  });
  return withXcodeProject(config, mod => {
    const phases = mod.modResults.hash.project.objects.PBXShellScriptBuildPhase;
    const original = '`"$NODE_BINARY" --print "require(\'path\').dirname(require.resolve(\'react-native/package.json\')) + \'/scripts/react-native-xcode.sh\'"`';
    const quoted = '"$("$NODE_BINARY" --print "require(\'path\').dirname(require.resolve(\'react-native/package.json\')) + \'/scripts/react-native-xcode.sh\'")"';
    let found = false;
    for (const phase of Object.values(phases)) {
      if (typeof phase !== 'object' || phase.name !== '"Bundle React Native code and images"' || !phase.shellScript) continue;
      const script = JSON.parse(phase.shellScript);
      if (script.includes(quoted)) found = true;
      if (!script.includes(original)) continue;
      phase.shellScript = JSON.stringify(script.replace(original, quoted));
      found = true;
    }
    if (!found) throw new Error('Expo bundle script changed; review the path-quoting workaround.');
    return mod;
  });
};
