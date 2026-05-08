-- ═══════════════════════════════════════════════════════════════
-- AUDIT TRAIL MIGRATION
-- Run this SQL once on your Railway MySQL database
-- ═══════════════════════════════════════════════════════════════

-- 1. Login / Session Logs
CREATE TABLE IF NOT EXISTS login_logs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  user_role   ENUM('admin','worker','client') NOT NULL,
  user_name   VARCHAR(255),
  action      ENUM('LOGIN','LOGOUT','LOGIN_FAILED') NOT NULL,
  ip_address  VARCHAR(45),
  user_agent  VARCHAR(500),
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id   (user_id),
  INDEX idx_action    (action),
  INDEX idx_created   (created_at)
);

-- 2. Activity / Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  user_role   ENUM('admin','worker','client') NOT NULL,
  action_type ENUM('CREATE','UPDATE','DELETE','VIEW') NOT NULL,
  module_name VARCHAR(100) NOT NULL,
  record_id   INT,
  old_value   JSON,
  new_value   JSON,
  description TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_id     (user_id),
  INDEX idx_action_type (action_type),
  INDEX idx_module      (module_name),
  INDEX idx_created     (created_at)
);

-- Done!
