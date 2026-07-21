const { createClient } = require('@supabase/supabase-js');

// Lazily initialized — avoids crashing at module load when env vars are not yet set.
let _supabaseAdmin = null;

function getAdminClient() {
  if (_supabaseAdmin) return _supabaseAdmin;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Missing Supabase service environment variables (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
  }
  _supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return _supabaseAdmin;
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  let supabaseAdmin;
  try {
    supabaseAdmin = getAdminClient();
  } catch (configErr) {
    console.error('[AUTH] Supabase admin client not configured:', configErr.message);
    return res.status(503).json({ error: 'Auth service unavailable' });
  }

  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = user;
  next();
}

module.exports = requireAuth;
