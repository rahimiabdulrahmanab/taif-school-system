// One-shot script: create (or reset) the Finance role user.
//   node scripts/create_finance_user.js
// Reads DATABASE_URL from .env. The finance user has role='finance' and
// the frontend / server.js gate restrict them to fees, payroll, office
// expenses and external income only.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool   = require('../src/db');

const USERNAME  = 'finance';
const PASSWORD  = 'Finance@2026';
const FULL_NAME = 'Finance Officer';

(async () => {
  try {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const exists = await pool.query(
      'SELECT id FROM admin_users WHERE username = $1', [USERNAME]
    );

    if (exists.rows.length) {
      await pool.query(
        `UPDATE admin_users
            SET password_hash = $1, full_name = $2, role = 'finance'
          WHERE username = $3`,
        [hash, FULL_NAME, USERNAME]
      );
      console.log(`✔ Updated existing user "${USERNAME}" (role=finance).`);
    } else {
      await pool.query(
        `INSERT INTO admin_users (username, password_hash, full_name, role)
         VALUES ($1, $2, $3, 'finance')`,
        [USERNAME, hash, FULL_NAME]
      );
      console.log(`✔ Created new user "${USERNAME}" (role=finance).`);
    }

    console.log('');
    console.log('  Username : ' + USERNAME);
    console.log('  Password : ' + PASSWORD);
    console.log('');
    console.log('  Change the password after first login via the Change');
    console.log('  Password screen (works for any role).');
  } catch (err) {
    console.error('✘ Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
