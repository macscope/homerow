terraform {
  backend "s3" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_token
}

resource "cloudflare_record" "mail_a" {
  count   = var.manage_mail_dns ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "mail"
  content = var.mail_server_ipv4
  type    = "A"
  proxied = false
  allow_overwrite = true
}

resource "cloudflare_record" "webmail_a" {
  zone_id = var.cloudflare_zone_id
  name    = var.webmail_subdomain
  content = var.mail_server_ipv4
  type    = "A"
  proxied = false
  allow_overwrite = true
}

resource "cloudflare_record" "rspamd_a" {
  count   = var.manage_mail_dns ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "rspamd"
  content = var.mail_server_ipv4
  type    = "A"
  proxied = false
  allow_overwrite = true
}

resource "cloudflare_record" "mx" {
  count    = var.manage_mail_dns ? 1 : 0
  zone_id  = var.cloudflare_zone_id
  name     = "@"
  content  = "mail.${var.domain}"
  type     = "MX"
  priority = 10
  allow_overwrite = true
}

resource "cloudflare_record" "spf" {
  count   = var.manage_mail_dns ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "@"
  content = "v=spf1 mx a:mail.${var.domain} -all"
  type    = "TXT"
  allow_overwrite = true
}

resource "cloudflare_record" "dmarc" {
  count   = var.manage_mail_dns ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "_dmarc"
  content = "v=DMARC1; p=quarantine; rua=mailto:admin@${var.domain}"
  type    = "TXT"
  allow_overwrite = true
}

variable "domain" {
  type = string
}

variable "cloudflare_token" {
  type      = string
  sensitive = true

  validation {
    condition     = trimspace(var.cloudflare_token) != ""
    error_message = "cloudflare_token must not be empty."
  }
}

variable "cloudflare_zone_id" {
  type = string

  validation {
    condition     = trimspace(var.cloudflare_zone_id) != ""
    error_message = "cloudflare_zone_id must not be empty."
  }
}

variable "mail_server_ipv4" {
  type = string
}

variable "webmail_subdomain" {
  type    = string
  default = "webmail"

  validation {
    condition     = trimspace(var.webmail_subdomain) != ""
    error_message = "webmail_subdomain must not be empty."
  }

  validation {
    condition     = lower(trimspace(var.webmail_subdomain)) != "mail"
    error_message = "webmail_subdomain must not be 'mail' to avoid mail host overlap."
  }
}

variable "manage_mail_dns" {
  type    = bool
  default = true
}
