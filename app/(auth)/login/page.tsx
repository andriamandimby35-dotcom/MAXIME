"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { toLoginEmail } from "@/lib/auth-identifier";

export default function LoginPage() {

  const router = useRouter();

  const [signup, setSignup] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");



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