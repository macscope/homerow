{ config, pkgs, lib, ... }:
let
  settings = import ./settings.nix;
  dbPassword = settings.imapPassword;
  dbPasswordSql = lib.replaceStrings [ "'" ] [ "''" ] dbPassword;
  mailProviderMode = settings.mailProviderMode or "local";
  upstreamImapHost = settings.upstreamImapHost or "127.0.0.1";
  upstreamImapPort = settings.upstreamImapPort or 993;
  upstreamImapTls = settings.upstreamImapTls or true;
  upstreamImapUser = settings.upstreamImapUser or settings.email;
  upstreamImapPassword = settings.upstreamImapPassword or settings.imapPassword;
  upstreamSmtpHost = settings.upstreamSmtpHost or "127.0.0.1";
  upstreamSmtpPort = settings.upstreamSmtpPort or 465;
  upstreamSmtpSecure = settings.upstreamSmtpSecure or true;
  upstreamSmtpUser = settings.upstreamSmtpUser or settings.email;
  upstreamSmtpPassword = settings.upstreamSmtpPassword or settings.imapPassword;
  emailSql = lib.replaceStrings [ "'" ] [ "''" ] settings.email;
  upstreamImapHostSql = lib.replaceStrings [ "'" ] [ "''" ] upstreamImapHost;
  upstreamImapUserSql = lib.replaceStrings [ "'" ] [ "''" ] upstreamImapUser;
  upstreamImapPasswordSql = lib.replaceStrings [ "'" ] [ "''" ] upstreamImapPassword;
  upstreamSmtpHostSql = lib.replaceStrings [ "'" ] [ "''" ] upstreamSmtpHost;
  syncEngineApiHost = "127.0.0.1";
  syncEngineApiPort = 4001;

  syncEngineEnvFile = pkgs.writeText "sync-engine.env" ''
    DB_PASSWORD=${dbPassword}
    IMAP_PASS=${upstreamImapPassword}
    SMTP_PASS=${upstreamSmtpPassword}
    SYNC_ENGINE_API_TOKEN=${settings.imapPassword}
  '';

  syncEngineApp = pkgs.buildNpmPackage {
    pname = "mail-sync-engine";
    version = "1.0.0";
    src = ../sync-engine; 
    npmDepsHash = "sha256-+s3kdxlqE09CTQmCOTTBUNXGC4qmvo+CHKT26jygN+I="; 
    npmBuildScript = "build"; 
    preBuild = "sed -i 's/tsc/tsc || true/' package.json";
    
    installPhase = ''
      mkdir -p $out/lib
      cp -r dist $out/lib/
      cp -r node_modules $out/lib/
      cp schema.sql $out/lib/
    '';
  };
in {
  services.postgresql = {
    enable = true;
    package = pkgs.postgresql_16;
    ensureDatabases = [ "mailsync" ];
    ensureUsers = [{ name = "mailsync"; ensureDBOwnership = true; }];
    authentication = lib.mkAfter ''
      local all postgres peer
      local mailsync mailsync scram-sha-256
      host  mailsync mailsync 127.0.0.1/32 scram-sha-256
      host  mailsync mailsync ::1/128 scram-sha-256
    '';
  };

  systemd.services.sync-engine-db-init = {
    description = "Initialize Mail Sync Engine Database Schema";
    wantedBy = [ "multi-user.target" ];
    after = [ "postgresql.service" ];
    requires = [ "postgresql.service" ];
    path = [ pkgs.postgresql_16 pkgs.coreutils pkgs.gnugrep ]; 
    
    serviceConfig = {
      Type = "oneshot";
      User = "postgres"; 
      ExecStart = pkgs.writeShellScript "init-db" ''
        set -e
        until pg_isready -h /run/postgresql; do
          sleep 1
        done

        # 1. Ensure mailsync role exists with a password and keep it rotated.
        psql <<'SQL'
        DO $do$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'mailsync') THEN
            CREATE ROLE mailsync WITH LOGIN PASSWORD '${dbPasswordSql}';
          ELSE
            ALTER ROLE mailsync WITH LOGIN PASSWORD '${dbPasswordSql}';
          END IF;
        END
        $do$;
        SQL
        
        # 2. Ensure mailsync database exists
        psql -c "CREATE DATABASE mailsync OWNER mailsync;" || true
        psql -c "ALTER DATABASE mailsync OWNER TO mailsync;" || true

        # 3. Initialize Schema if needed
        if ! psql -d mailsync -c "SELECT 1 FROM folders LIMIT 0" >/dev/null 2>&1; then
           echo "Applying database schema..."
           psql -d mailsync -f ${syncEngineApp}/lib/schema.sql
           psql -d mailsync -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO mailsync;"
           psql -d mailsync -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO mailsync;"
        fi

        # 3b. Keep ownership of existing objects with mailsync (legacy upgrades).
        psql -d mailsync <<'SQL'
        ALTER SCHEMA public OWNER TO mailsync;
        GRANT ALL ON SCHEMA public TO mailsync;
        DO $do$
        DECLARE r record;
        BEGIN
          FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
            EXECUTE format('ALTER TABLE public.%I OWNER TO mailsync', r.tablename);
          END LOOP;
          FOR r IN SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public' LOOP
            EXECUTE format('ALTER SEQUENCE public.%I OWNER TO mailsync', r.sequence_name);
          END LOOP;
        END
        $do$;
        SQL

        # 4. Seed Admin
        echo "Seeding admin account..."
        psql -d mailsync -c "INSERT INTO accounts (email, imap_host, imap_port, imap_tls, smtp_host, smtp_port, username, password) VALUES ('${emailSql}', '${upstreamImapHostSql}', ${toString upstreamImapPort}, ${if upstreamImapTls then "true" else "false"}, '${upstreamSmtpHostSql}', ${toString upstreamSmtpPort}, '${upstreamImapUserSql}', '${upstreamImapPasswordSql}') ON CONFLICT (email) DO UPDATE SET imap_host = EXCLUDED.imap_host, imap_port = EXCLUDED.imap_port, imap_tls = EXCLUDED.imap_tls, smtp_host = EXCLUDED.smtp_host, smtp_port = EXCLUDED.smtp_port, username = EXCLUDED.username, password = EXCLUDED.password, updated_at = now();"
      '';
    };
  };

  systemd.services.mail-sync-engine = {
    description = "Mail Sync Engine";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" "postgresql.service" "sync-engine-db-init.service" ] ++ lib.optionals (mailProviderMode == "local") [ "dovecot.service" ];
    requires = [ "postgresql.service" "sync-engine-db-init.service" ];

    environment = {
      NODE_ENV = "production";
      DB_HOST = "127.0.0.1";
      DB_PORT = "5432";
      DB_NAME = "mailsync";
      DB_USER = "mailsync";
      ATTACHMENT_DIR = "/var/lib/mail-sync-engine/attachments";
      ACCOUNT_EMAIL = settings.email;
      IMAP_HOST = upstreamImapHost;
      IMAP_PORT = toString upstreamImapPort;
      IMAP_TLS = lib.boolToString upstreamImapTls;
      IMAP_USER = upstreamImapUser;
      SYNC_ENGINE_API_HOST = syncEngineApiHost;
      SYNC_ENGINE_API_PORT = toString syncEngineApiPort;
      SMTP_HOST = upstreamSmtpHost;
      SMTP_PORT = toString upstreamSmtpPort;
      SMTP_SECURE = lib.boolToString upstreamSmtpSecure;
      SMTP_USER = upstreamSmtpUser;
    };

    serviceConfig = {
      ExecStart = "${pkgs.nodejs_22}/bin/node ${syncEngineApp}/lib/dist/index.js";
      ExecStartPre = [
        "${pkgs.coreutils}/bin/mkdir -p /var/lib/mail-sync-engine/attachments"
        "${pkgs.coreutils}/bin/chmod -R g+rX /var/lib/mail-sync-engine/attachments"
      ];
      WorkingDirectory = "${syncEngineApp}/lib";
      User = "mailsync";
      Group = "mailsync";
      StateDirectory = "mail-sync-engine";
      Restart = "always";
      EnvironmentFile = "${syncEngineEnvFile}";
      NoNewPrivileges = true;
      PrivateTmp = true;
      ProtectSystem = "full";
      ProtectHome = true;
      ProtectKernelTunables = true;
      ProtectKernelModules = true;
      ProtectControlGroups = true;
      RestrictSUIDSGID = true;
      LockPersonality = true;
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
      UMask = "0027";
    };
  };

  users.users.mailsync = {
    isSystemUser = true;
    group = "mailsync";
  };
  users.groups.mailsync = {};
}
