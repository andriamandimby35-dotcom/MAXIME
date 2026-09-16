"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";


export default function NewTenderPage() {


  const supabase = createClient();

  const router = useRouter();


  const [loading, setLoading] = useState(false);



  async function submit(
    e: React.FormEvent<HTMLFormElement>
  ) {

    e.preventDefault();

    setLoading(true);



    try {


      const form = new FormData(
        e.currentTarget
      );


      const title =
        form.get("title") as string;


      const reference =
        form.get("reference") as string;


      const client_name =
        form.get("client_name") as string;


      const description =
        form.get("description") as string;


      const deadline =
        form.get("deadline") as string;


      const estimated_amount =
        Number(
          form.get("estimated_amount")
        );


      const file =
        form.get("document") as File;



      let documentUrl = null;



      /*
      ==========================
      UPLOAD PDF STORAGE
      ==========================
      */


      if (file && file.size > 0) {


        const fileName =
          `${Date.now()}-${file.name}`;



        const {
          error: uploadError
        } =
        await supabase.storage
        .from("tender-documents")
        .upload(
          fileName,
          file,
          {
            cacheControl:"3600",
            upsert:false
          }
        );



        if (uploadError) {

          console.error(
            "UPLOAD ERROR :",
            uploadError
          );

          alert(
            "Erreur upload PDF : "
            + uploadError.message
          );

          return;

        }




        const {
          data:urlData
        } =
        supabase.storage
        .from("tender-documents")
        .getPublicUrl(
          fileName
        );



        documentUrl =
          urlData.publicUrl;



        console.log(
          "PDF URL :",
          documentUrl
        );


      }




      /*
      ==========================
      RECUPERATION ORGANISATION
      ==========================
      */


      const {
        data:userData
      } =
      await supabase.auth.getUser();



      if (!userData.user) {

        alert(
          "Utilisateur non connecté"
        );

        return;

      }



      const {
        data:membership,
        error:membershipError
      }
      =
      await supabase
      .from(
        "organization_members"
      )
      .select(
        "organization_id"
      )
      .eq(
        "user_id",
        userData.user.id
      )
      .single();



      if (membershipError) {

        console.error(
          membershipError
        );

        alert(
          "Organisation introuvable"
        );

        return;

      }




      /*
      ==========================
      CREATION DAO
      ==========================
      */


      const {
        error
      }
      =
      await supabase
      .from("tenders")
      .insert({

        organization_id:
          membership.organization_id,

        title,

        reference,

        client_name,

        description,

        deadline,

        estimated_amount,

        document_url:

          documentUrl,

        status:
          "draft"

      });



      if (error) {


        console.error(
          "ERREUR CREATION DAO :",
          error
        );


        alert(
          error.message
        );


        return;

      }



      alert(
        "DAO créé avec succès"
      );



      router.push(
        "/tenders"
      );



    }

    catch(error:any){


      console.error(
        error
      );


      alert(
        "Erreur : "
        + error.message
      );


    }


    finally {


      setLoading(false);


    }


  }




  return (

    <main className="p-8">

      <Link href="/tenders" className="tenderBackLink">← Retour aux appels d’offres</Link>


      <h1 className="text-4xl font-bold mb-3">
        Nouvel appel d&apos;offre
      </h1>


      <p className="mb-8 text-gray-600">
        Création d&apos;un nouveau dossier DAO
      </p>



      <form
        onSubmit={submit}
        className="space-y-4"
      >



        <input
          name="title"
          placeholder="Titre du DAO"
          className="w-full border p-3 rounded-lg"
          required
        />



        <input
          name="reference"
          placeholder="Référence DAO"
          className="w-full border p-3 rounded-lg"
          required
        />



        <input
          name="client_name"
          placeholder="Nom du client"
          className="w-full border p-3 rounded-lg"
          required
        />



        <textarea
          name="description"
          placeholder="Description du projet"
          className="w-full border p-3 rounded-lg"
          required
        />



        <input
          type="date"
          name="deadline"
          className="w-full border p-3 rounded-lg"
          required
        />



        <input
          type="number"
          name="estimated_amount"
          placeholder="Montant estimé"
          className="w-full border p-3 rounded-lg"
          required
        />



        <div>

          <label className="block mb-2">
            Document DAO PDF
          </label>


          <input
            type="file"
            name="document"
            accept="application/pdf"
            className="w-full border p-3 rounded-lg"
          />

        </div>




        <button
          disabled={loading}
          className="
          bg-green-800
          text-white
          px-6
          py-3
          rounded-lg
          "
        >

          {
            loading
            ?
            "Création..."
            :
            "Créer l'appel d'offre"
          }

        </button>



      </form>


    </main>

  );

}
