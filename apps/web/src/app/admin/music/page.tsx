import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TONE_MOODS } from "@/lib/media/music";
import { presignGet } from "@/lib/r2";
import { deleteTrack, uploadTrack } from "./actions";

export const dynamic = "force-dynamic";

export default async function MusicPage() {
  const rows = await db.select().from(schema.musicLibrary).orderBy(desc(schema.musicLibrary.createdAt));
  const links = new Map<string, string>();
  for (const r of rows) {
    try {
      links.set(r.id, await presignGet(r.r2Path, 600));
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Music library</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a track</CardTitle>
          <CardDescription>
            Used when Mubert is not enabled or fails. Mood tags are matched against the script tone:{" "}
            {Object.entries(TONE_MOODS).map(([tone, m]) => `${tone} → ${m.tags.join("/")}`).join("; ")}. Tracks are looped in the mix, so 60–120 s is enough. Music is ducked −12 dB under the voice.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={uploadTrack} className="grid gap-3 md:grid-cols-3" resetOnSuccess>
            <div className="space-y-1">
              <Label htmlFor="file">Audio file (MP3/WAV/M4A/MP4/AAC/OGG, ≤ 25 MB)</Label>
              <Input id="file" name="file" type="file" accept="audio/*,video/mp4,.mp3,.wav,.m4a,.mp4,.aac,.ogg,.flac" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="title">Title</Label>
              <Input id="title" name="title" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="moodTags">Mood tags (comma-separated)</Label>
              <Input id="moodTags" name="moodTags" placeholder="news, neutral, minimal" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="licence">Licence *</Label>
              <Input id="licence" name="licence" placeholder="Purchased: … / CC BY 4.0 …" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="licenceUrl">Licence URL</Label>
              <Input id="licenceUrl" name="licenceUrl" type="url" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="durationSec">Duration (s, optional)</Label>
              <Input id="durationSec" name="durationSec" type="number" step="0.1" />
            </div>
            <div className="md:col-span-3">
              <Button type="submit">Upload</Button>
            </div>
          </ActionForm>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Moods</TableHead>
                <TableHead>Licence</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Listen</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.title}</TableCell>
                  <TableCell className="text-xs">{r.moodTags.join(", ")}</TableCell>
                  <TableCell className="text-xs">
                    {r.licenceUrl ? (
                      <a href={r.licenceUrl} target="_blank" rel="noreferrer" className="underline">
                        {r.licence}
                      </a>
                    ) : (
                      r.licence
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{r.durationSec ? `${Number(r.durationSec).toFixed(0)} s` : "—"}</TableCell>
                  <TableCell>{links.get(r.id) ? <audio controls preload="none" src={links.get(r.id)} className="h-8 w-56" /> : null}</TableCell>
                  <TableCell>
                    <ActionForm action={deleteTrack}>
                      <input type="hidden" name="id" value={r.id} />
                      <Button type="submit" size="sm" variant="ghost" className="text-destructive">
                        Delete
                      </Button>
                    </ActionForm>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    No tracks yet — timelines are built with voice only until a track or a Mubert key exists.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
