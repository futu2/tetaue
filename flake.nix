{
  description = "tetaue — a pure functional SQL query language (bun/TypeScript)";

  inputs = {
    # Fast-moving bun runtime; the flake pins its own unstable channel, so the
    # host system's channel doesn't matter.
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    # Converts bun.lock (text lockfile, bun >= 1.2) into the hermetic bun.nix
    # dependency set; exposes mkDerivation/fetchBunDeps/hook.
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  # Speeds up the first build of the bun2nix CLI itself (Rust).
  nixConfig = {
    extra-substituters = [ "https://nix-community.cachix.org" ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  outputs =
    { self, nixpkgs, bun2nix }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      # Everything that depends on the target platform.
      perSystem = system:
        let
          pkgs = nixpkgs.legacyPackages.${system};

          # bun2nix package; exposes mkDerivation / fetchBunDeps / hook via passthru.
          b2n = bun2nix.packages.${system}.default;

          # The flake source (git tree; node_modules and dist are git-ignored).
          src = self;

          # Single source of truth for the version.
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

          # Hermetic copy of bun's install cache, fetched from the pinned
          # bun.lock (via bun.nix). Replaces a network `bun install`.
          bunDeps = b2n.fetchBunDeps {
            bunNix = ./bun.nix;
          };

          # npm dependencies of the VS Code extension, fetched from
          # extension/package-lock.json (npm cache, used offline).
          extensionNpmDeps = pkgs.fetchNpmDeps {
            src = ./extension;
            hash = "sha256-BL0ky/Ui8722Hrqm46XW+iplDlVOA6iHxiASL88y4Vs=";
          };
        in
        rec {
          # Self-contained tetaue CLI: `bun build --compile` embeds the bun
          # runtime, so the result runs on machines without bun or node.
          package = b2n.mkDerivation {
            pname = "tetaue";
            inherit version src bunDeps;
            # Same entry point as `bun run build:standalone`.
            module = "bin/tetaue.ts";
            # Match the repo's own build flags (upstream doesn't use bytecode).
            bunCompileToBytecode = false;
            # The full suite needs node and a built LSP server bundle;
            # it runs under `nix flake check` via checks.tests instead.
            dontUseBunCheck = true;
            meta = {
              description = "tetaue — a pure functional SQL query language";
              homepage = "https://github.com/futu2/tetaue";
              license = pkgs.lib.licenses.mit;
              mainProgram = "tetaue";
            };
          };

          # Full test suite (needs node for the LSP-over-stdio tests and a
          # freshly built language server bundle).
          tests = pkgs.stdenv.mkDerivation {
            pname = "tetaue-tests";
            inherit version src bunDeps;
            nativeBuildInputs = [ b2n.hook pkgs.nodejs ];
            dontUseBunBuild = true;
            dontUseBunCheck = true;
            dontUseBunInstall = true;
            doCheck = true;
            buildPhase = ''
              runHook preBuild
              # Note: langium:generate currently fails upstream (langium-cli
              # jsonschema URL bug), so the committed generated files are used,
              # exactly like the package build.
              bun run build:server
              runHook postBuild
            '';
            checkPhase = ''
              runHook preCheck
              bun test
              runHook postCheck
            '';
            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              runHook postInstall
            '';
          };

          # The packaged VSIX (like `bun run package:extension`):
          # server bundle + tsc-compiled client, zipped by vsce. The output is
          # the .vsix file itself, so `nix build .#vsix` gives a file you can
          # `code --install-extension result`.
          vsix = pkgs.stdenv.mkDerivation {
            # Name ends in .vsix so the store path matches the unpack hook used
            # by `extension` below (and so `nix build .#vsix` gives a nice file).
            name = "tetaue-vscode-${version}.vsix";
            inherit version src bunDeps extensionNpmDeps;
            nativeBuildInputs = [ b2n.hook pkgs.nodejs pkgs.git ];
            dontUseBunBuild = true;
            dontUseBunCheck = true;
            dontUseBunInstall = true;
            buildPhase = ''
              runHook preBuild
              # 1. bundle the LSP server (plain Node ESM) into extension/server/
              bun run build:server
              # 2. install the extension's npm dependencies from the fetched cache
              pushd extension
              npm ci --offline --ignore-scripts --no-audit --no-fund --cache "$extensionNpmDeps"
              # 3. compile the client. The npm .bin shims point at /usr/bin/env
              # (absent in the sandbox), so run the real JS entry points with
              # node directly.
              node node_modules/typescript/bin/tsc -p ./
              # 4. package the .vsix
              node node_modules/@vscode/vsce/vsce package --allow-missing-repository
              popd
              runHook postBuild
            '';
            installPhase = ''
              runHook preInstall
              cp extension/*.vsix "$out"
              runHook postInstall
            '';
          };

          # The same extension as a nixpkgs vscode extension (unpacks the vsix
          # above), installable on NixOS via home-manager:
          #   programs.vscode.extensions = [ tetaue.packages.${system}.extension ];
          extension = pkgs.vscode-utils.buildVscodeExtension {
            pname = "tetaue-vscode";
            inherit version;
            src = vsix;
            vscodeExtPublisher = "tetaue";
            vscodeExtName = "tetaue-vscode";
            vscodeExtUniqueId = "tetaue.tetaue-vscode";
          };

          devShell = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.nodejs
              pkgs.nixpkgs-fmt
              b2n # `bun2nix -o bun.nix` regenerates bun.nix after lockfile changes
            ];
            shellHook = ''
              if [ ! -d node_modules ]; then
                echo "installing bun dependencies…"
                bun install
              fi
            '';
          };

          formatter = pkgs.nixpkgs-fmt;
        };
    in
    {
      packages = forAllSystems (system: {
        default = (perSystem system).package;
        vsix = (perSystem system).vsix;
        extension = (perSystem system).extension;
      });
      checks = forAllSystems (system: { tests = (perSystem system).tests; });
      devShells = forAllSystems (system: { default = (perSystem system).devShell; });
      formatter = forAllSystems (system: (perSystem system).formatter);
    };
}
