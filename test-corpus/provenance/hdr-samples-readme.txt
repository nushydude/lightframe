# HDR Sample Images

A collection of RAW image files and their corresponding developed HDR and SDR images released under the Creative Commons Zero license, created for testing software tools that display or convert HDR images.

![Preview image](preview.jpg)

## Capture technique and technical background

The images were taken using a professional digital single-lens mirrorless (DSLM) camera, the Nikon Z8, with various lenses. During the capture an effort was made to manually set the exposure using aperture, shutter speed and ISO in a way that the sensor's dynamic range was used in an optimal way, and therefore optimized for HDR development.

In particular, Exposure to the Right (ETTR) was performed, which means to open the aperture as far as possible or to set the shutter speed as long as practically possible to get the maximum amount of light on the sensor without clipping elements of the 14-bit Bayer matrix of the RAW image file.

When shooting directly into the sun, some clipping was accepted and minimized as far as possible. Using this technique ensures that the maximum dynamic range is captured, so the RAW files are a good base to develop HDR images from them using a RAW developer.

The RAW developer used in this instance is Adobe Lightroom Classic on Microsoft Windows using an HDR monitor with an HDR1000 certification. All HDR images have been developed, so their maximum luminance does not exceed 1000 nits as this is the brightest luminance the monitor used could display and is also the most common standard for HDR monitors.

## Content of the repository

This repository has a size of about 10 GiB and uses Git LFS for storage. It contains multiple folders, each for a different test use case. Currently the following folders are available:

- image_gallery_hdr_sdr_raw_png_avif_jpeg: This is the main test folder. It contains 28 images with their RAW files, RAW histograms, HDR PNGs, SDR PNGs, HDR AVIFs, SDR AVIFs, SDR JPEGs and screenshots of the development settings and output histograms of the images in Adobe Lightroom to enable the reproduction of these files from the RAW images. This represents what a real photographer's project folder could look like.

- different_file_formats_in_sdr_and_hdr: This folder contains multiple image files, but all with the same content. The difference lies in the multitude of file formats in the same folder. The following versions are available: HDR PNG, SDR PNG, HDR AVIF, SDR AVIF, HDR HEIC, SDR HEIC, HDR JPEG-XL, SDR JPEG-XL, SDR JPEG, HDR TIFF and SDR TIFF. This folder can be used to test if an image viewer supports all these file types and to test the correct interpretation of SDR and HDR files next to each other.

- exif_orientation_test: This folder contains three JPEG images, each with the same content. The difference lies in the EXIF metadata, which specifies the "orientation". The first image has no such flag, the second is mirrored and the third is rotated. This folder can be used to determine if an image viewer correctly interprets the EXIF information and flips or rotates the view.

- high_resolution_images: This folder contains three images with a very high resolution of 16512x11008 pixels (181.8 MP) as RAW files, HDR AVIFs and SDR AVIFs. The images were captured using the PixelShift technology of the Nikon Z8 camera. This technique takes a series of 32 images, each with a slightly shifted sensor position to artificially increase the resolution over a period of about 5 seconds. These RAW images are then combined in Nikon NX Studio into a single RAW file. This final RAW file is developed in Adobe Lightroom, like any other RAW file, into both an SDR AVIF and an HDR AVIF. These test images can be used to evaluate the support and performance of applications when loading images with large resolutions or file sizes.

## Intention and License

All image files in this repository are licensed under the Creative Commons Zero (CC0) license, meaning they are free to use in any project, for any purpose, with no attribution required.

The goal of this repository is to provide high-quality, real-world RAW and HDR image samples that can be used for the development and testing of software tools supporting HDR image formats. Unlike many test images, which are often low-resolution, synthetic, or not fully representative of HDR color space, these images aim to reflect realistic scenarios as captured by professional photographers in the field. This ensures more practical and meaningful testing for software developers working with HDR content.