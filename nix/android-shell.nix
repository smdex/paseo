# Android mobile client dev shells for NixOS hosts.
#
# Expo/React Native Android builds stay impure on purpose: npm and Gradle fetch
# their own dependencies at build time, so the SDK composition below only pins
# the parts Gradle cannot fetch itself (see docs/android.md, "NixOS (flake dev
# shell)").
{
  pkgs,
}:

let
  # Mirrors the toolchain pinned in `.tool-versions` (java 21, android-sdk 21.0
  # → API 35 tooling). The SDK lives in the read-only Nix store, so every
  # component Gradle needs must be composed here — unlike a mise-managed
  # writable SDK, Gradle cannot self-install missing pieces. The generated
  # android project currently compiles against API 36 with build-tools 36
  # while the repo docs still reference 35, so both levels are composed.
  androidComposition = pkgs.androidenv.composeAndroidPackages {
    platformVersions = [
      "35"
      "36"
    ];
    buildToolsVersions = [
      "35.0.0"
      "36.0.0"
    ];
    platformToolsVersion = "latest";
    cmdLineToolsVersion = "latest";
    # The React Native Gradle plugin requires an NDK even for prebuilt
    # `react-android` AAR builds, and the store SDK is read-only, so every NDK
    # version requested by the app and vendored modules must be composed here
    # rather than auto-installed by Gradle: the root project pins one, the
    # vendored diff prototype module pins the other.
    includeNDK = true;
    ndkVersions = [
      "27.1.12297006"
      "27.0.12077973"
    ];
    extraLicenses = [
      "android-sdk-license"
      "android-sdk-preview-license"
    ];
  };

  # Same toolchain plus emulator and a system image, for testing without a
  # physical phone. Kept separate so `nix develop .#android` does not pull a
  # multi-gigabyte emulator closure when a device is plugged in via USB.
  emulatorComposition = pkgs.androidenv.composeAndroidPackages {
    platformVersions = [ "35" "36" ];
    buildToolsVersions = [ "35.0.0" "36.0.0" ];
    includeNDK = true;
    ndkVersions = [ "27.1.12297006" "27.0.12077973" ];
    platformToolsVersion = "latest";
    cmdLineToolsVersion = "latest";
    includeEmulator = true;
    emulatorVersion = "latest";
    includeSystemImages = true;
    systemImageTypes = [ "google_apis" ];
    abiVersions = [ "x86_64" ];
    extraLicenses = [
      "android-sdk-license"
      "android-sdk-preview-license"
      "intel-android-extra-license"
      "intel-android-sysimage-license"
    ];
  };

  androidSdkRoot = "${androidComposition.androidsdk}/libexec/android-sdk";

  # The Gradle daemon runs on JDK 17: `.tool-versions` pins java 21 for
  # general dev tooling (kept on PATH below), but several first-party Gradle
  # plugin subprojects request a Java 17 toolchain, and Gradle cannot
  # auto-provision one on NixOS (the downloaded JDK binary expects an FHS
  # dynamic linker). Running the daemon on 17 satisfies those requests via
  # the current JVM; JDK 21 stays on PATH for everything else.
  jdk17 = pkgs.jdk17.home;

  # Android Gradle Plugin runs an `aapt2` binary fetched from Maven that is
  # linked for conventional Linux distros and dies on NixOS (no /lib64/ld-linux).
  # Point it at the patchelf'd build-tools copy from the composed SDK instead.
  # `-Dorg.gradle.project.<name>` promotes a JVM system property set through
  # GRADLE_OPTS to the Gradle project property AGP reads. (Do NOT route
  # `org.gradle.java.installations.*` through GRADLE_OPTS: Gradle 8.14 only
  # honors those from gradle.properties; the daemon JVM is pinned to 17
  # above instead.)
  gradleOpts = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${androidSdkRoot}/build-tools/35.0.0/aapt2";
in
{
  android = pkgs.mkShell {
    name = "paseo-android";
    packages = [
      pkgs.jdk21
      pkgs.jdk17 # Gradle toolchain target for Expo plugin subprojects
      pkgs.nodejs_22
      androidComposition.androidsdk # adb, sdkmanager, avdmanager on PATH
    ];
    JAVA_HOME = jdk17;
    ANDROID_HOME = androidSdkRoot;
    ANDROID_SDK_ROOT = androidSdkRoot;
    GRADLE_OPTS = gradleOpts;
  };

  android-emulator = pkgs.mkShell {
    name = "paseo-android-emulator";
    packages = [
      pkgs.jdk21
      pkgs.jdk17
      pkgs.nodejs_22
      emulatorComposition.androidsdk # adb, sdkmanager, avdmanager, emulator
    ];
    JAVA_HOME = jdk17;
    ANDROID_HOME = "${emulatorComposition.androidsdk}/libexec/android-sdk";
    ANDROID_SDK_ROOT = "${emulatorComposition.androidsdk}/libexec/android-sdk";
    GRADLE_OPTS = gradleOpts;
  };
}
