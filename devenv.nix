{
  pkgs,
  inputs,
  ...
}:

let
  system = pkgs.stdenv.hostPlatform.system;
  llmAgents = inputs.llm-agents.packages.${system};
  paseo = pkgs.callPackage ./nix/package.nix {
    # fetchNpmDeps output depends on the nixpkgs revision. Keep this override
    # local to devenv, whose nixpkgs input is locked independently of flake.lock.
    npmDepsHash = "sha256-WHqWMIqganiTllugHTlN339vjgHyaCn9i29rQqKcBKo=";
  };
  versionParts = pkgs.lib.splitString "." paseo.version;
  desktopBuildVersion = pkgs.lib.concatStringsSep "." [
    (builtins.elemAt versionParts 0)
    (builtins.elemAt versionParts 1)
    "0"
  ];
in
{
  packages = [
    pkgs.jujutsu
    pkgs.nodejs_22
    pkgs.python3
    llmAgents.beads
    llmAgents.openspec
    llmAgents.codegraph
    llmAgents.gitnexus
  ];

  outputs = {
    paseo = paseo;
    desktop = pkgs.callPackage ./nix/desktop-package.nix {
      inherit paseo;
      buildVersion = desktopBuildVersion;
    };
  };
}
