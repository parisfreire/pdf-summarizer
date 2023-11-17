import { createUploadthing, type FileRouter } from "uploadthing/next";
import {getKindeServerSession} from "@kinde-oss/kinde-auth-nextjs/server";
import {db} from "@/db";
import {PDFLoader} from 'langchain/document_loaders/fs/pdf'
import {pinecone} from '@/lib/pinecone'
import {OpenAIEmbeddings} from "langchain/embeddings/openai"
import {PineconeStore} from "langchain/vectorstores/pinecone"

const f = createUploadthing();

// FileRouter for your app, can contain multiple FileRoutes
export const ourFileRouter = {
    pdfUploader: f({ pdf: { maxFileSize: "4MB" } })
        .middleware(async ({ req }) => {
            // This code runs on your server before upload
            const { getUser } = getKindeServerSession()
            const user = await getUser()
            // If you throw, the user will not be able to upload
            if(!user || !user.id) throw new Error("UNAUTHORIZED")
            // Whatever is returned here is accessible in onUploadComplete as `metadata`
            return { userId: user.id };
        })
        .onUploadComplete(async ({ metadata, file }) => {
            // This code RUNS ON YOUR SERVER after upload
            console.log("Upload complete for user:", metadata.userId);

            const createdFile = await db.file.create({
                data: {
                    key: file.key,
                    name: file.name,
                    userId: metadata.userId,
                    url: `https://uploadthing-prod.s3.us-west-2.amazonaws.com/${file.key}`,
                    uploadStatus: 'PROCESSING'
                }
            })

            try{
                const response = await fetch(
                    `https://uploadthing-prod.s3.us-west-2.amazonaws.com/${file.key}`
                );
                const blob = await response.blob();
                const loader = new PDFLoader(blob);
                const pageLevelDocs = (await loader.load()).map((doc) => {
                    return {
                        ...doc,
                        metadata: {
                            ...doc.metadata,
                            "file.id": createdFile.id,
                        },
                    };
                });

                const pagesAmt = pageLevelDocs.length;
                //vectorize and index entire document

                const pineconeIndex = await pinecone
                    .Index("pdf-summarizer")
                    .namespace(metadata.userId);

                const embeddings = new OpenAIEmbeddings({
                    openAIApiKey: process.env.OPENAI_API_KEY,
                });

                await PineconeStore.fromDocuments(pageLevelDocs, embeddings, {
                    pineconeIndex,
                });
                await db.file.update({
                    data:{
                        uploadStatus:"SUCCESS"
                    },
                    where:{
                        id:createdFile.id
                    }
                })
            }catch(err){
                console.log("error: ", err);
                await db.file.update({
                    data:{
                        uploadStatus: "FAILED"
                    },
                    where:{
                        id: createdFile.id
                    }
                })
            }

            // !!! Whatever is returned here is sent to the clientside `onClientUploadComplete` callback
        }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;