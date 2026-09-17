"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { toLoginEmail } from "@/lib/auth-identifier";

export default function LoginPage() {

  const router = useRouter();

  const [signup, setSignup] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Message affiché quand /projects/layout a déconnecté un compte
  // conducteur/chef qui n'est plus attaché à aucun chantier (chantier
  // supprimé) : voir app/(dashboard)/layout.tsx.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("acces") === "chantier_supprime") {
      setError("Votre accès a été retiré : le chantier auquel vous étiez attaché a été supprimé. Contactez l'administrateur si vous pensez qu'il s'agit d'une erreur.");
    }
  }, []);



  async function submit(e: React.FormEvent<HTMLFormElement>) {

    e.preventDefault();

    setLoading(true);
    setError("");

    const form = new FormData(e.currentTarget);

    const rawIdentifier = String(form.get("email"));
    // Un conducteur ou chef de chantier peut se connecter avec un simple nom
    // (attribué par l'administrateur) plutôt qu'une vraie adresse e-mail ;
    // signup reste réservé à une vraie adresse pour le compte entreprise.
    const email = signup ? rawIdentifier : toLoginEmail(rawIdentifier);
    const password = String(form.get("password"));

    const supabase = createClient();

    let result;


    if (signup) {

      const full_name = String(form.get("full_name") || "");
      const company_name = String(form.get("company_name") || "");


      result = await supabase.auth.signUp({

        email,
        password,

        options: {
          data: {
            full_name,
            company_name
          }
        }

      });


    } else {


      result = await supabase.auth.signInWithPassword({

        email,
        password

      });


    }



    if (result.error) {

      setError(result.error.message);

      setLoading(false);

      return;

    }



    router.push("/dashboard");

    router.refresh();


  }



  return (

    <main className="auth">

      {/* Logo en haut à droite de la page de connexion (image fournie par
          l'utilisateur), en plus du fond d'écran chantier déjà utilisé une
          fois connecté (voir .auth dans globals.css). */}
      <Image src="/images/logo-m.png" alt="" width={78} height={80} className="authLogo" priority />

      <form
        className="authCard"
        onSubmit={submit}
      >


        <div className="logo">
          SB
        </div>


        <h1>
          Sébastien BTP
        </h1>


        <p>
          Application de gestion BTP de <strong>May&Lanah</strong>.
        </p>



        {signup && (

          <input
            name="full_name"
            placeholder="Nom complet"
            required
          />

        )}



        {signup && (

          <input
            name="company_name"
            placeholder="Nom entreprise"
            required
          />

        )}



        <input

          name="email"

          type={signup ? "email" : "text"}

          placeholder={signup ? "E-mail" : "Identifiant (nom ou e-mail)"}

          required

          defaultValue={signup ? "andriamandimby@icloud.com" : undefined}

          autoCapitalize="none"

          autoCorrect="off"

          spellCheck={false}

          autoComplete="username"

        />



        <input

          name="password"

          type="password"

          placeholder="Mot de passe"

          required

          autoCapitalize="none"

          autoCorrect="off"

          spellCheck={false}

          autoComplete="current-password"

        />



        <small>

          Pour votre sécurité, n’utilisez pas le mot de passe partagé dans la conversation.

        </small>



        {error && (

          <div className="error">

            {error}

          </div>

        )}



        <button

          type="submit"

          disabled={loading}

        >

          {loading 

          ? "Connexion..." 

          : signup 

          ? "Créer mon entreprise" 

          : "Se connecter"}

        </button>



        <button

          type="button"

          className="ghost"

          onClick={() => {

            setSignup(!signup);

            setError("");

          }}

        >

          {signup 

          ? "J'ai déjà un compte" 

          : "Créer mon entreprise"}

        </button>



      </form>


    </main>

  );

}