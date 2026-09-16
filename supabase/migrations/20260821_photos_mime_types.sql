-- Le bucket btp-documents n'acceptait que jpeg/png/pdf/doc. Les photos prises
-- directement depuis l'appareil photo d'un téléphone (notamment iPhone, qui
-- capture en HEIC/HEIF par défaut) étaient donc rejetées silencieusement à
-- l'upload — le rapport se sauvegardait quand même, mais sans la photo.
-- On élargit aux formats image usuels avec un joker pour couvrir tout format
-- image futur (webp, gif, etc.) sans nouvelle migration à chaque fois.
update storage.buckets
set allowed_mime_types = array[
  'image/*',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]
where id = 'btp-documents';
