{
  description = "Standalone Mail Server Deployment";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

    # Mail Server Module
    simple-nixos-mailserver.url = "gitlab:simple-nixos-mailserver/nixos-mailserver";
    simple-nixos-mailserver.inputs.nixpkgs.follows = "nixpkgs";

    # Disk Partitioning
    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";

    # Local Development Environment (Devenv)
    devenv.url = "github:cachix/devenv";
    
    # REMOVED: webmail input (handled internally by modules/webmail.nix now)
  };

  outputs = { self, nixpkgs, devenv, simple-nixos-mailserver, disko, ... }@inputs:
    let
      systems = [ "aarch64-darwin" "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      deploySettings =
        if builtins.pathExists ./modules/settings.nix
        then import ./modules/settings.nix
        else {};
      mailProviderMode = deploySettings.mailProviderMode or "local";
      mailModules = nixpkgs.lib.optionals (mailProviderMode == "local") [
        simple-nixos-mailserver.nixosModule
        ./modules/mail.nix
      ];
    in {

      # --- 1. Local Development Environment (macOS & Linux) ---
      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = devenv.lib.mkShell {
            inherit inputs pkgs;
            modules = [
              ./devenv.nix
              {
               devenv.root = let cwd = builtins.getEnv "PWD"; in if cwd == "" then ./. else cwd;
              }
            ];
          };
        }
      );

      # --- 2. Declarative Deploy Entry Point ---
      apps = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          deployApp = pkgs.writeShellApplication {
            name = "deploy";
            runtimeInputs = [ pkgs.bash pkgs.git ];
            text = ''
              exec env INSTALL_STRICT_CONFIG=1 "${self}/scripts/install.sh" "$@"
            '';
          };
        in {
          deploy = {
            type = "app";
            program = "${deployApp}/bin/deploy";
          };
          default = {
            type = "app";
            program = "${deployApp}/bin/deploy";
          };
        }
      );

      # --- 3. Production Mail Server Configuration (Linux Server) ---
      nixosConfigurations.mailserver = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules =
          [
            disko.nixosModules.disko
            ./modules/disk-config.nix
            ./modules/configuration.nix
          ]
          ++ mailModules
          ++ [
            ./modules/backup.nix
            ./modules/sync-engine.nix
          ];
      };
    };
}
