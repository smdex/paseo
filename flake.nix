{
  description = "Paseo - self-hosted daemon for AI coding agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    {
      self,
      nixpkgs,
    }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor = system: import nixpkgs { inherit system; };
      # Android SDK components are unfree, so the mobile-client shells import
      # their own nixpkgs with license acceptance instead of loosening the
      # flake's default (free-only) package set. See nix/android-shell.nix.
      androidShellsFor =
        system:
        import ./nix/android-shell.nix {
          pkgs = import nixpkgs {
            inherit system;
            config = {
              allowUnfree = true;
              android_sdk.accept_license = true;
            };
          };
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          paseo = pkgs.callPackage ./nix/package.nix { };
          versionParts = pkgs.lib.splitString "." paseo.version;
          sourceRevision = if self ? revCount && self.revCount != null then self.revCount else 0;
          buildRevision = sourceRevision - (sourceRevision / 10000) * 10000;
          desktopBuildVersion = pkgs.lib.concatStringsSep "." [
            (builtins.elemAt versionParts 0)
            (builtins.elemAt versionParts 1)
            (toString buildRevision)
          ];
        in
        {
          default = paseo;
          paseo = paseo;
          desktop = pkgs.callPackage ./nix/desktop-package.nix {
            inherit paseo;
            buildVersion = desktopBuildVersion;
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          packages = self.packages.${system};
          license = (builtins.fromJSON (builtins.readFile ./package.json)).license;
        in
        {
          license-metadata =
            assert packages.paseo.meta.license.spdxId == license;
            assert packages.desktop.meta.license.spdxId == license;
            pkgs.runCommand "paseo-license-metadata" { } "touch $out";
        }
      );

      nixosModules.default = self.nixosModules.paseo;
      nixosModules.paseo =
        { pkgs, lib, ... }:
        {
          imports = [ ./nix/module.nix ];
          services.paseo.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.python3
            ];
          };
        }
        # The Android SDK shells are Linux-only; macOS uses the mise-managed
        # toolchain documented in docs/android.md.
        // nixpkgs.lib.optionalAttrs (nixpkgs.lib.systems.elaborate { inherit system; }).isLinux (
          androidShellsFor system
        )
      );
    };
}
