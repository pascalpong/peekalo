const { withMainActivity } = require('expo/config-plugins');

// Deliberately constrained to the Expo SDK 55 Kotlin template. Native lifecycle
// changes must fail prebuild for review, rather than silently losing protection.
const marker = 'Peekalo secure window:';
const secureFlag = 'window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)';
const createTemplate = `  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    super.onCreate(null)
  }`;
const createGuard = `    // ${marker} before Activity content creation
    ${secureFlag}
`;
const lifecycleGuards = `

  // ${marker} restore around native resume callbacks
  override fun onResume() {
    ${secureFlag}
    super.onResume()
    ${secureFlag}
  }

  // ${marker} restore when the Activity regains window focus
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    if (hasFocus) {
      ${secureFlag}
    }
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) {
      ${secureFlag}
    }
  }`;
const occurrences = (source, value) => source.split(value).length - 1;
const changedTemplate = detail => new Error(`Peekalo Android secure window: ${detail}; review the Expo SDK 55 Kotlin MainActivity template before prebuild.`);

function protectMainActivity(contents, language) {
  if (language !== 'kt') throw changedTemplate('unsupported MainActivity language, expected Kotlin');
  if (typeof contents !== 'string') throw changedTemplate('MainActivity contents are unavailable');
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  let source = contents.replace(/\r\n/g, '\n');

  // Strip only our exact, complete previous output before validating the template.
  // A marker alone is insufficient: incomplete or edited protection must fail.
  if (source.includes(marker)) {
    if (occurrences(source, createGuard) !== 1 || occurrences(source, lifecycleGuards) !== 1) {
      throw changedTemplate('generated protection was edited, duplicated or is incomplete');
    }
    source = source.replace(createGuard, '').replace(lifecycleGuards, '');
    if (source.includes(marker)) throw changedTemplate('unrecognized generated protection marker');
  }

  if (occurrences(source, 'class MainActivity') !== 1 || !/^class MainActivity : ReactActivity\(\) \{$/m.test(source)) {
    throw changedTemplate('unsupported Activity declaration');
  }
  if (/\bfun\s+(?:onResume|onWindowFocusChanged)\b/.test(source) || /\bFLAG_SECURE\b/.test(source)) {
    throw changedTemplate('conflicting lifecycle override or secure-window code already exists');
  }
  if (occurrences(source, createTemplate) !== 1 || (source.match(/\bfun\s+onCreate\b/g) ?? []).length !== 1 || occurrences(source, 'super.onCreate(') !== 1) {
    throw changedTemplate('unsupported onCreate body');
  }

  const protectedCreate = createTemplate.replace('    super.onCreate(null)', `${createGuard}    super.onCreate(null)`);
  return source.replace(createTemplate, protectedCreate + lifecycleGuards).replace(/\n/g, newline);
}

module.exports = function withAndroidSecureWindow(config) {
  return withMainActivity(config, mod => {
    mod.modResults.contents = protectMainActivity(mod.modResults.contents, mod.modResults.language);
    return mod;
  });
};
