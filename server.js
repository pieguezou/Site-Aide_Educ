require("dotenv").config();
const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const session = require("express-session");
const nodemailer = require("nodemailer"); // ✅ AJOUT

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Connexion MySQL (pool)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// ---------------------------
// Middleware
// ---------------------------
app.use(express.urlencoded({ extended: false })); // remplace bodyParser
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "votre_secret_ici",
    resave: false,
    saveUninitialized: true,
  })
);

// ---------------------------
// ✅ EMAIL: transport + fonction notification
// ---------------------------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false, // true uniquement si port 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function notifierNouvelleReservation({
  utilisateurEmail,
  utilisateurTelephone,
  date_heure_rdv,
  type_prestation,
  commentaire_reservation,
}) {
  const to = process.env.NOTIFY_TO || "olivier.guez@gmail.com";

  const subject = `Nouvelle réservation (${type_prestation}) - ${date_heure_rdv}`;

  const text = `Nouvelle réservation enregistrée

Utilisateur : ${utilisateurEmail}
Téléphone : ${utilisateurTelephone || "Non renseigné"}
Date/Heure : ${date_heure_rdv}
Motif : ${type_prestation}
Commentaire : ${commentaire_reservation}
`;

  await transporter.sendMail({
    from: `"Réservations" <${process.env.SMTP_USER}>`,
    to,
    subject,
    text,
  });
}

// ---------------------------
// Créer un utilisateur
// ---------------------------
app.post("/ajouter", async (req, res) => {
  const {
    utilisateur_email,
    utilisateur_nom,
    utilisateur_telephone,
    utilisateur_password,
    confirmation_passwd,
  } = req.body;

  try {
    if (
      !utilisateur_email ||
      !utilisateur_nom ||
      !utilisateur_telephone ||
      !utilisateur_password ||
      !confirmation_passwd
    ) {
      return res.status(400).send("Tous les champs sont obligatoires.");
    }

    if (utilisateur_password !== confirmation_passwd) {
      return res.status(400).send("Les mots de passe ne correspondent pas.");
    }

    if (utilisateur_password.length < 8) {
      return res
        .status(400)
        .send("Le mot de passe doit contenir au moins 8 caractères.");
    }

    // ✅ Vérifier si email existe déjà
    const [rows] = await pool.query(
      "SELECT Utilisateur_Email FROM utilisateur WHERE Utilisateur_Email = ? LIMIT 1",
      [utilisateur_email]
    );

    if (rows.length > 0) {
      return res.status(400).send("Cette adresse email est déjà utilisée.");
    }

    const hash = await bcrypt.hash(utilisateur_password, 10);

    await pool.query(
      "INSERT INTO utilisateur (Utilisateur_Email, Utilisateur_Password, Utilisateur_Telephone, utilisateur_nom) VALUES (?, ?, ?, ?)",
      [utilisateur_email, hash, utilisateur_telephone, utilisateur_nom]
    );

    res.send("Utilisateur enregistré avec succès !");
  } catch (err) {
    console.error("ERREUR SQL :", err);
    res.status(500).send("Erreur serveur.");
  }
});

// ---------------------------
// Connexion
// ---------------------------
app.post("/verifier-email", async (req, res) => {
  const { utilisateur_email, utilisateur_password } = req.body;

  try {
    const [rows] = await pool.query(
      "SELECT * FROM utilisateur WHERE Utilisateur_Email = ? LIMIT 1",
      [utilisateur_email]
    );

    if (rows.length === 0) {
      return res.send("Email introuvable. Veuillez créer un compte d'abord.");
    }

    const user = rows[0];

    const match = await bcrypt.compare(
      utilisateur_password,
      user.Utilisateur_Password
    );
    if (!match) return res.send("Mot de passe incorrect.");

    req.session.email = utilisateur_email; // <- on met bien l'email en session
    req.session.telephone = user.Utilisateur_Telephone; // <- on peut aussi stocker le téléphone si besoin
    return res.redirect("/reservation");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Erreur serveur");
  }
});

// ---------------------------
// Page réservation
// ---------------------------
app.get("/reservation", (req, res) => {
  if (!req.session.email) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "reservation.html"));
});

// ---------------------------
// API email session
// ---------------------------
//app.get("/session-email", (req, res) => {
 // res.json({ email: req.session.email || null });
//});
app.get("/session-email", (req, res) => {
  res.json({
    email: req.session.email || null,
    telephone: req.session.telephone || null,
  });
});


// ---------------------------
// Enregistrer réservation
// ---------------------------
app.post("/reserver", async (req, res) => {
  if (!req.session.email) return res.status(401).send("Non authentifié.");

  const {
    date_reservation,
    heure_reservation,
    type_prestation,
    commentaire_reservation,
  } = req.body;

  try {
    const date_heure_rdv = `${date_reservation} ${heure_reservation}:00`;

    await pool.query(
      "INSERT INTO reservation (utilisateur_email, date_heure_rdv, type_prestation, commentaire_reservation) VALUES (?, ?, ?, ?)",
      [req.session.email, date_heure_rdv, type_prestation, commentaire_reservation]
    );

    // ✅ ENVOI MAIL AUTOMATIQUE
    try {
      await notifierNouvelleReservation({
        utilisateurEmail: req.session.email,
        utilisateurTelephone: req.session.telephone,
        date_heure_rdv,
        type_prestation,
        commentaire_reservation,
      });
    } catch (mailErr) {
      console.error("ERREUR MAIL :", mailErr);
      // on ne bloque pas la réservation si le mail échou
    }

    res.send(`
      <h2> Réservation enregistrée, je vais rapidement prendre contact avec vous pour valider ce rendez-vous !</h2>
        <a href="/connexion.html" class="btn">cofirmer</a>
    `);
  } catch (err) {
    console.error("ERREUR SQL :", err);
    res.status(500).send("Erreur lors de l'enregistrement : " + err.message);
  }
});

// ---------------------------
// Mes réservations
// ---------------------------
app.get("/mes-reservations", async (req, res) => {
  if (!req.session.email) {
    return res.status(401).json({ error: "Non authentifié" });
  }

  try {
    const [rows] = await pool.query(
      `SELECT date_heure_rdv, type_prestation, commentaire_reservation
       FROM reservation
       WHERE utilisateur_email = ?
       ORDER BY date_heure_rdv`,
      [req.session.email]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ---------------------------
// Page principale
// ---------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------------------------
// Lancer serveur
// ---------------------------
app.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
});