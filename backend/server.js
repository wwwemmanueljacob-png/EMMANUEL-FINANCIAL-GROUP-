
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY;

let supabase = null;
let authClient = null;

if (
  SUPABASE_URL &&
  SUPABASE_SERVICE_ROLE_KEY &&
  SUPABASE_ANON_KEY
) {
  try {
    supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        },
        realtime: {
          transport: WebSocket
        }
      }
    );

  authClient = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    },
    realtime: {
      transport: WebSocket
    }
  }
);

    console.log("EMF Supabase clients initialized.");
  } catch (error) {
    console.error(
      "Supabase initialization failed:",
      error.message
    );
  }
} else {
  console.warn(
    "Supabase configuration is incomplete. Check Railway variables."
  );
}

function requireSupabase(res) {
  if (!supabase || !authClient) {
    res.status(503).json({
      success: false,
      message: "Authentication service is not configured."
    });
    return false;
  }

  return true;
}

function validEmail(email) {
  return (
    typeof email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  );
}

async function getAuthenticatedUser(req) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return { user: null, error: "Missing authentication token." };
  }

  const { data, error } = await supabase.auth.getUser(
    match[1]
  );

  if (error || !data.user) {
    return { user: null, error: "Invalid or expired session." };
  }

  return { user: data.user, error: null };
}

async function linkCustomerToAuthUser(user) {
  if (!user.email || !user.email_confirmed_at) {
    return {
      customer: null,
      error: "Please verify your email address before signing in."
    };
  }

  const { data: customer, error } = await supabase
    .from("customers")
    .select(
      "id, full_name, email, phone, address, account_number, account_status, auth_user_id"
    )
    .ilike("email", user.email)
    .maybeSingle();

  if (error) {
    console.error("Customer lookup failed:", error.message);

    return {
      customer: null,
      error: "Unable to retrieve customer account."
    };
  }

  if (!customer) {
    return {
      customer: null,
      error: "No customer record matches this verified email."
    };
  }

  if (
    customer.auth_user_id &&
    customer.auth_user_id !== user.id
  ) {
    return {
      customer: null,
      error: "This customer record is already linked to another login."
    };
  }

  if (!customer.auth_user_id) {
    const { data: updated, error: updateError } =
      await supabase
        .from("customers")
        .update({ auth_user_id: user.id })
        .eq("id", customer.id)
        .is("auth_user_id", null)
        .select(
          "id, full_name, email, phone, address, account_number, account_status, auth_user_id"
        )
        .maybeSingle();

    if (updateError) {
      console.error(
        "Customer linking failed:",
        updateError.message
      );

      return {
        customer: null,
        error: "Unable to link customer account."
      };
    }

    if (updated) {
      return { customer: updated, error: null };
    }

    // Another request may have linked this same user.
    const { data: current, error: checkError } =
      await supabase
        .from("customers")
        .select(
          "id, full_name, email, phone, address, account_number, account_status, auth_user_id"
        )
        .eq("id", customer.id)
        .maybeSingle();

    if (
      checkError ||
      !current ||
      current.auth_user_id !== user.id
    ) {
      return {
        customer: null,
        error: "Unable to securely link customer account."
      };
    }

    return { customer: current, error: null };
  }

  return { customer, error: null };
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "EMMANUEL FINANCIAL GROUP API is running.",
    version: "1.0.0"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    api: "online",
    supabaseConfigured: Boolean(supabase && authClient),
    timestamp: new Date().toISOString()
  });
});

app.get("/api/health/supabase", async (req, res) => {
  if (!requireSupabase(res)) return;

  try {
    const { error } = await supabase
      .from("customers")
      .select("id")
      .limit(1);

    if (error) {
      console.error("Supabase query failed:", error.message);

      return res.status(503).json({
        success: false,
        message: "Supabase query failed.",
        code: error.code || "DATABASE_ERROR"
      });
    }

    return res.json({
      success: true,
      message: "EMF backend successfully queried Supabase."
    });
  } catch (error) {
    console.error(
      "Supabase connection test failed:",
      error.message
    );

    return res.status(503).json({
      success: false,
      message: "Supabase connection test failed."
    });
  }
});


/* =====================================================
   CUSTOMER REGISTRATION
   Creates a new Auth user and customers table record.
===================================================== */

app.post("/api/auth/register", async (req, res) => {
  if (!requireSupabase(res)) return;

  let newAuthUserId = null;

  try {
    const fullName =
      typeof req.body.full_name === "string"
        ? req.body.full_name.trim()
        : "";

    const email =
      typeof req.body.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";

    const phone =
      typeof req.body.phone === "string"
        ? req.body.phone.trim()
        : "";

    const password = req.body.password;

    if (fullName.length < 2 || fullName.length > 120) {
      return res.status(400).json({
        success: false,
        message: "Enter your full legal name."
      });
    }

    if (!validEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address."
      });
    }

    if (
      typeof password !== "string" ||
      password.length < 8
    ) {
      return res.status(400).json({
        success: false,
        message: "Password must contain at least 8 characters."
      });
    }

    if (phone.length > 30) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid phone number."
      });
    }

    // Check whether a customer record already uses this email.
    const { data: existingCustomer, error: lookupError } =
      await supabase
        .from("customers")
        .select("id")
        .ilike("email", email)
        .maybeSingle();

    if (lookupError) {
      console.error(
        "Registration lookup failed:",
        lookupError.message
      );

      return res.status(500).json({
        success: false,
        message: "Unable to check registration details."
      });
    }

    if (existingCustomer) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists. Please sign in or contact support."
      });
    }

    // Create the Supabase Auth account.
    const { data, error } = await authClient.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName
        }
      }
    });

    if (error) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    if (!data.user?.id) {
      return res.status(500).json({
        success: false,
        message: "Registration could not be completed. Please try again."
      });
    }

    // Detect an existing Auth account when Supabase
    // returns an empty identities list.
    if (
      Array.isArray(data.user.identities) &&
      data.user.identities.length === 0
    ) {
      return res.status(409).json({
        success: false,
        message: "This email may already be registered. Please sign in or reset your password."
      });
    }

    newAuthUserId = data.user.id;

    // Create the matching customer record.
    const { error: customerError } = await supabase
      .from("customers")
      .insert({
        full_name: fullName,
        email: email,
        phone: phone || null,
        account_status: "PENDING",
        auth_user_id: newAuthUserId
      });

    if (customerError) {
      console.error(
        "Customer record creation failed:",
        customerError.message
      );

      // Attempt to remove the Auth user if the
      // customer record could not be created.
      const { error: cleanupError } =
        await supabase.auth.admin.deleteUser(newAuthUserId);

      if (cleanupError) {
        console.error(
          "Auth cleanup failed:",
          cleanupError.message
        );
      }

      return res.status(500).json({
        success: false,
        message: "Your customer record could not be created. Please try again or contact support."
      });
    }

    return res.status(201).json({
      success: true,
      message: data.session
        ? "Registration successful. You can sign in."
        : "Registration successful. Check your email for a verification link before signing in.",
      requiresEmailVerification: !data.user.email_confirmed_at
    });

  } catch (error) {
    console.error(
      "Registration failed:",
      error.message
    );

    // Best-effort cleanup if an unexpected error occurs
    // after the Auth user has been created.
    if (newAuthUserId) {
      const { error: cleanupError } =
        await supabase.auth.admin.deleteUser(newAuthUserId);

      if (cleanupError) {
        console.error(
          "Auth cleanup failed:",
          cleanupError.message
        );
      }
    }

    return res.status(500).json({
      success: false,
      message: "Registration could not be completed."
    });
  }
});


// CUSTOMER LOGIN
app.post("/api/auth/login", async (req, res) => {
  if (!requireSupabase(res)) return;

  try {
    const email =
      typeof req.body.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";

    const password = req.body.password;

    if (
      !validEmail(email) ||
      typeof password !== "string" ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter your email address and password."
      });
    }

    const { data, error } =
      await authClient.auth.signInWithPassword({
        email,
        password
      });

    if (error || !data.user || !data.session) {
      return res.status(401).json({
        success: false,
        message:
          "Sign-in failed. Check your details and verify your email if required."
      });
    }

    const { customer, error: linkError } =
      await linkCustomerToAuthUser(data.user);

    if (linkError) {
      return res.status(403).json({
        success: false,
        message: linkError
      });
    }

    return res.json({
      success: true,
      message: "Customer login successful.",
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      customer
    });
  } catch (error) {
    console.error("Login failed:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to complete sign-in."
    });
  }
});

// SIGNED-IN CUSTOMER PROFILE
app.get("/api/customer/me", async (req, res) => {
  if (!requireSupabase(res)) return;

  try {
    const { user, error: authError } =
      await getAuthenticatedUser(req);

    if (authError || !user) {
      return res.status(401).json({
        success: false,
        message: authError || "Authentication required."
      });
    }

    const { data: customer, error } = await supabase
      .from("customers")
      .select(
        "id, full_name, email, phone, address, account_number, account_status, created_at"
      )
      .eq("auth_user_id", user.id)
      .maybeSingle();

    if (error) {
      console.error("Profile lookup failed:", error.message);

      return res.status(500).json({
        success: false,
        message: "Unable to retrieve customer profile."
      });
    }

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "No customer profile is linked to this login."
      });
    }

    return res.json({
      success: true,
      customer
    });
  } catch (error) {
    console.error("Profile request failed:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to retrieve customer profile."
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint not found."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`EMF backend listening on port ${PORT}`);
});
